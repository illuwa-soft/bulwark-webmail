/* Test plugin: all example workflow decisions stay inside this sandbox. */
/* global require, exports, URL, location, document, console */
const react = require('react');
const { ui } = require('@plugin-host');
const h = react.createElement;

function ExamplePage() {
  const [filter, setFilter] = react.useState('');
  const [result, setResult] = react.useState('Idle');
  const running = react.useRef(null);
  const open = async (origin, title = 'Example external view') => {
    const operation = {};
    running.current = operation;
    let approved = false;
    const url = new URL('/workspace/', origin);
    url.searchParams.set('parent', new URL(location.href).origin);
    url.searchParams.set('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    url.searchParams.set('dir', document.documentElement.dir || 'ltr');
    try {
      const opened = await ui.embeddedView({ action: 'open', url: url.href, title });
      while (running.current === operation) {
        const event = await ui.embeddedView({ action: 'next', id: opened.id });
        console.info('[example-view]', event?.type, event?.data?.type);
        if (!event) break;
        if (event.type === 'message') {
          if (event.data.type === 'input') {
            approved = false;
            await ui.embeddedView({ action: 'update', id: opened.id, preventUnload: true });
            await ui.embeddedView({ action: 'post', id: opened.id, data: { type: 'echo', value: event.data.value } });
          }
          if (event.data.type === 'approve') {
            approved = true;
            await ui.embeddedView({ action: 'post', id: opened.id, data: { type: 'approved' } });
          }
        }
        if (event.type === 'leave') {
          await ui.embeddedView({ action: 'reply', id: opened.id, requestId: event.requestId, allow: approved });
          if (approved) break;
        }
        if (event.type === 'overflow') setResult('Data gap reported');
      }
      if (running.current === operation) {
        running.current = null;
        setResult('View closed');
      }
    } catch (error) {
      console.error('[example-view]', error);
      if (running.current === operation) {
        running.current = null;
        setResult('View unavailable');
      }
    }
  };
  return h('main', { style: { padding: 16 } },
    h('h1', null, 'Example views'),
    h('label', null, 'Retained input', h('input', { 'aria-label': 'Retained input', value: filter, onChange: event => setFilter(event.target.value), style: { display: 'block', width: '100%', maxWidth: 320, padding: 12 } })),
    h('button', { onClick: () => void open('https://canvas.test'), style: { minHeight: 44, padding: 12, margin: 8 } }, 'Open canvas'),
    h('button', { onClick: () => void open('https://form.test', 'Example external view with a long title '.repeat(6)), style: { minHeight: 44, padding: 12, margin: 8 } }, 'Open form'),
    h('p', { role: 'status' }, result));
}

exports.activate = () => ui.setPages([{ id: 'workspace', title: 'Example views', icon: 'Puzzle' }]);
exports.slots = { 'app-page': { component: ExamplePage } };
