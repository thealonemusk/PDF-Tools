// Password tools: add a password (AES-256) or remove one.
import { el, withBusy, download, toast, field, baseName } from '../lib/ui.js';
import { openForEdit, readFile, isEncryptedPdf } from '../lib/pdf.js';
import { singlePdfTool, actionButton, panel } from '../lib/tool.js';

export const protect = {
  id: 'protect',
  title: 'Protect PDF',
  desc: 'Encrypt your PDF with a password (AES-256) and control printing, copying and editing.',
  color: '#34495e',
  icon: 'protect',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, layout }) => {
      const pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Password' });
      const pw2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password' });
      const show = el('input', { type: 'checkbox' });
      show.addEventListener('change', () => (pw.type = pw2.type = show.checked ? 'text' : 'password'));
      const perms = [
        ['printing', 'Allow printing'],
        ['copying', 'Allow copying text and images'],
        ['modifying', 'Allow editing'],
        ['annotating', 'Allow comments and form filling'],
      ].map(([key, label]) => ({ key, box: el('input', { type: 'checkbox', checked: true }), label }));

      layout.work.append(
        el('div', { class: 'compress-intro' },
          el('h3', {}, 'How it works'),
          el('p', { class: 'muted' }, 'Anyone opening the file will need this password. The file is encrypted with AES-256 right here in your browser — the password is never sent anywhere.'),
          el('p', { class: 'muted' }, 'Keep the password safe: there is no way to recover a forgotten one.'),
        ),
      );
      layout.side.append(
        panel('Set a password', field('Password', pw), field('Repeat password', pw2),
          el('label', { class: 'check-row' }, show, 'Show password')),
        panel('Permissions', ...perms.map((p) => el('label', { class: 'check-row' }, p.box, p.label)),
          el('small', { class: 'help' }, 'Permissions are honoured by standard PDF viewers.')),
        actionButton('Protect PDF', () => {
          if (pw.value.length < 1) return toast('Enter a password.', 'error');
          if (pw.value !== pw2.value) return toast('The passwords don’t match.', 'error');
          return withBusy('Encrypting…', async () => {
            const doc = await openForEdit(bytes);
            const permissions = Object.fromEntries(perms.map((p) => [p.key, p.box.checked]));
            // `true` alone only grants low-resolution printing
            if (permissions.printing) permissions.printing = 'highResolution';
            permissions.fillingForms = permissions.annotating;
            permissions.documentAssembly = permissions.modifying;
            permissions.contentAccessibility = true;
            // A random owner password makes the permissions binding for everyone who opens it with the password.
            const ownerPassword = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
            doc.encrypt({ userPassword: pw.value, ownerPassword, permissions });
            download(await doc.save(), `${baseName(file.name)}_protected.pdf`);
            toast('Protected PDF downloaded.', 'success');
          });
        }),
      );
    });
  },
};

export const unlock = {
  id: 'unlock',
  title: 'Unlock PDF',
  desc: 'Remove the password and restrictions from a PDF you have the password for.',
  color: '#1abc9c',
  icon: 'unlock',
  mount(container) {
    return singlePdfTool(container, this, async ({ file, bytes, layout }) => {
      // `bytes` were already decrypted when the file was opened (asking for the password if needed)
      const wasLocked = await isEncryptedPdf(await readFile(file));
      layout.work.append(
        el('div', { class: 'compress-intro' },
          el('h3', {}, wasLocked ? 'Ready to unlock' : 'This PDF isn’t protected'),
          el('p', { class: 'muted' }, wasLocked
            ? 'The unlocked copy opens without a password and has no printing, copying or editing restrictions.'
            : 'It has no password or restrictions, so there is nothing to remove.'),
        ),
      );
      const button = actionButton('Unlock PDF', () => {
        download(bytes, `${baseName(file.name)}_unlocked.pdf`);
        toast('Unlocked PDF downloaded.', 'success');
      });
      button.disabled = !wasLocked;
      layout.side.append(button);
    });
  },
};
