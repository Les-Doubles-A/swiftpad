import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--disable-background-networking','--disable-component-update'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const variants = process.argv.slice(2);
async function run(kind, mb) {
  await page.setContent(`<!doctype html><html><body style="margin:0"><div id=host></div></body></html>`);
  return page.evaluate(async ({kind, mb}) => {
    const line = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor 0123456789\n';
    const n = Math.ceil(mb * 1024 * 1024 / line.length);
    const text = line.repeat(n);
    const host = document.getElementById('host');
    const raf = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    let el;
    const t0 = performance.now();
    if (kind === 'ta-off' || kind === 'ta-soft') {
      el = document.createElement('textarea'); el.spellcheck = false; el.wrap = kind === 'ta-off' ? 'off' : 'soft';
      el.style.cssText = 'width:100%;height:780px;font:14px monospace;tab-size:4;' + (kind==='ta-off'?'white-space:pre;':'');
      host.appendChild(el); el.value = text;
    } else if (kind === 'ce-blocks') {
      el = document.createElement('div'); el.contentEditable = 'plaintext-only'; el.spellcheck = false;
      el.style.cssText = 'height:780px;overflow:auto;font:14px monospace;white-space:pre;outline:none';
      const L = 1000, lines = text.split('\n'); let html = [];
      const frag = document.createDocumentFragment();
      for (let i = 0; i < lines.length; i += L) { const d = document.createElement('div'); d.style.cssText = 'content-visibility:auto;contain-intrinsic-size:auto '+(Math.min(L, lines.length-i)*17)+'px'; d.textContent = lines.slice(i, i+L).join('\n') + '\n'; frag.appendChild(d); }
      el.appendChild(frag); host.appendChild(el);
    }
    el.focus();
    if (el.setSelectionRange) el.setSelectionRange(0,0); else { const s = getSelection(); s.collapse(el.firstChild.firstChild, 0); }
    await raf();
    const t1 = performance.now();
    const typ = [];
    for (let i = 0; i < 5; i++) { const a = performance.now(); document.execCommand('insertText', false, 'x'); el.offsetHeight; typ.push(+(performance.now() - a).toFixed(1)); }
    await raf();
    return { kind, mb, firstFrameMs: +(t1 - t0).toFixed(0), typingMs: typ };
  }, {kind, mb});
}
for (const v of variants) for (const mb of [1, 2, 3, 5]) console.log(JSON.stringify(await run(v, mb)));
await browser.close();
