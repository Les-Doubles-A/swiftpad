import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.setContent(`<!doctype html><html><body style="margin:0"><textarea id=t spellcheck=false wrap=off style="width:100%;height:780px;font:14px monospace;white-space:pre;tab-size:4"></textarea></body></html>`);
for (const mb of [1, 10, 50, 100]) {
  const r = await page.evaluate(async (mb) => {
    const line = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor 0123456789\n';
    const n = Math.ceil(mb * 1024 * 1024 / line.length);
    const text = line.repeat(n);
    const ta = document.getElementById('t');
    const raf = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    ta.value = ''; await raf();
    const t0 = performance.now();
    ta.value = text;
    const t1 = performance.now();
    ta.focus(); ta.setSelectionRange(0, 0);
    await raf();
    const t2 = performance.now();
    // typing at start (insertText keeps native undo)
    let typ = [];
    for (let i = 0; i < 5; i++) { const a = performance.now(); document.execCommand('insertText', false, 'x'); ta.offsetHeight; typ.push(performance.now() - a); }
    await raf();
    // typing in the middle
    const mid = Math.floor(text.length / 2); ta.setSelectionRange(mid, mid);
    let typMid = [];
    for (let i = 0; i < 5; i++) { const a = performance.now(); document.execCommand('insertText', false, 'y'); ta.offsetHeight; typMid.push(performance.now() - a); }
    await raf();
    const u0 = performance.now(); document.execCommand('undo'); ta.offsetHeight; const u1 = performance.now();
    const v0 = performance.now(); const val = ta.value; const v1 = performance.now();
    const ok = val.length === text.length + 5 + 4; // 5 x + 4 y after one undo (undo coalesces? check)
    // scroll to end
    const s0 = performance.now(); ta.scrollTop = ta.scrollHeight; ta.offsetHeight; await raf(); const s1 = performance.now();
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1;
    return { mb, setValueMs: +(t1-t0).toFixed(1), firstFrameMs: +(t2-t0).toFixed(1), typeStartMs: typ.map(x=>+x.toFixed(1)), typeMidMs: typMid.map(x=>+x.toFixed(1)), undoMs: +(u1-u0).toFixed(1), getValueMs: +(v1-v0).toFixed(1), lenAfterUndo: val.length - text.length, scrollEndMs: +(s1-s0).toFixed(1), jsHeapMB: mem };
  }, mb);
  console.log(JSON.stringify(r));
}
await browser.close();
