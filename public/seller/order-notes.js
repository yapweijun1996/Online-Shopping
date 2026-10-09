import './ops-copy.js';
import { formatDate, t } from '../shared/i18n.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };

/* Internal notes on one order: the list, and a form to add one. `send(body)` posts and resolves with the new note
   (or rejects with { status, code }); `onAdded(note)` lets the caller keep its copy of the order current. */
export function renderOrderNotes({ notes, send, onAdded, online = () => true }) {
  const section = node('section', 'order-detail-group order-notes');
  section.append(node('h3', '', t('notesTitle')), node('p', 'shop-note', t('notesHint')));
  const list = node('ul', 'order-note-list');
  const show = (items) => {
    list.replaceChildren(...(items.length ? items.map((note) => {
      const item = node('li');
      item.append(node('span', 'order-note-meta', `${note.author} · ${formatDate(note.createdAt)}`), node('p', 'order-note-body', note.body));
      return item;
    }) : [node('li', 'order-note-empty', t('notesEmpty'))]));
  };
  let items = [...notes];
  show(items);
  const form = node('form', 'order-note-form');
  const label = node('label'); label.append(node('span', '', t('notesLabel')));
  const input = node('textarea'); input.rows = 3; input.maxLength = 1000; input.required = true;
  label.append(input);
  const message = node('p', 'message'); message.setAttribute('role', 'status');
  const add = node('button', 'secondary-button', t('notesAdd')); add.type = 'submit';
  form.append(label, add, message);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim() || !online()) return;
    add.disabled = true; message.textContent = '';
    try {
      const note = await send({ body: input.value });
      items = [...items, note]; show(items); input.value = ''; onAdded(note);
    } catch (error) {
      if (error.status !== 401) message.textContent = t(error.code === 'TOO_MANY_NOTES' ? 'notesTooMany' : 'notesFailed');
    }
    if (add.isConnected) add.disabled = false;
  });
  section.append(list, form);
  return section;
}
