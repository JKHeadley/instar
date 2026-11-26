export function createCredentialSheet({ readDisclosure, submitConsent, signal, document: doc = globalThis.document }) {
  return async (requestId, opener) => {
    const reply = await readDisclosure(requestId);
    if (signal?.aborted) return { kind: 'cancelled' };
    if ([401, 403, 404, 409, 410].includes(reply?.status)) return { kind: 'stale' };
    const data = reply?.data;
    if (!reply?.ok || data?.requestId !== requestId || !/^[a-f0-9]{64}$/.test(data.disclosureId)
      || typeof data.title !== 'string' || typeof data.why !== 'string') return { kind: 'unavailable' };

    const make = (tag, text) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const dialog = make('dialog');
    dialog.className = 'needs-credential-dialog';
    dialog.setAttribute('aria-label', data.title);
    const form = make('form');
    const header = make('h2', data.title);
    const why = make('p', data.why);
    const label = make('label', 'Credential value');
    const input = make('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.required = true;
    input.maxLength = 10_000;
    label.append(input);
    const submit = make('button', 'Submit credential');
    submit.type = 'submit';
    const cancel = make('button', 'Cancel');
    cancel.type = 'button';
    const status = make('p');
    status.setAttribute('role', 'status');
    form.append(header, why);
    if (typeof data.detail === 'string' && data.detail) form.append(make('p', data.detail));
    form.append(label, submit, cancel, status);
    dialog.append(form);
    doc.body.append(dialog);

    return new Promise(resolve => {
      const abort = () => dialog.close();
      signal?.addEventListener('abort', abort, { once: true });
      let inFlight = false;
      let outcome = { kind: 'cancelled' };
      dialog.addEventListener('close', () => {
        input.value = '';
        signal?.removeEventListener('abort', abort);
        dialog.remove();
        resolve(outcome);
        doc.defaultView?.setTimeout(() => {
          if (opener?.isConnected && !opener.disabled) opener.focus();
        }, 0);
      }, { once: true });
      dialog.addEventListener('cancel', event => { if (inFlight) event.preventDefault(); });
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (inFlight || !input.value.trim()) return;
        inFlight = true;
        cancel.disabled = submit.disabled = true;
        const value = input.value;
        input.value = '';
        let result;
        try { result = await submitConsent(requestId, data.disclosureId, value); }
        catch { result = null; }
        if (signal?.aborted) return;
        if (result?.ok && result.data?.outcome === 'applied') outcome = { kind: 'applied' };
        else if ([401, 403, 404, 409, 410].includes(result?.status)) outcome = { kind: 'stale' };
        else if (result?.status === 400) {
          status.textContent = 'Enter the credential again.';
          inFlight = cancel.disabled = submit.disabled = false;
          input.focus();
          return;
        } else outcome = { kind: 'unavailable' };
        dialog.close();
      });
      dialog.showModal();
      input.focus();
    });
  };
}
