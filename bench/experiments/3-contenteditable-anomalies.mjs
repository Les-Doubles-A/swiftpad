import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--disable-background-networking'] });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 600 } });
const page = await ctx.newPage();
const css = `.ed{height:500px;overflow:auto;font:14px/20px monospace;white-space:pre;outline:none;tab-size:4} .ed>div{content-visibility:auto;contain-intrinsic-block-size:auto 2000px}`;
await page.setContent(`<!doctype html><style>${css}</style><div id=a class=ed contenteditable=plaintext-only spellcheck=false><div>l1\nl2\nl3</div><div>l4\nl5</div></div><div id=b class=ed contenteditable=plaintext-only spellcheck=false><div>B1</div></div>`);
const ser = `(el) => [...el.childNodes].map(n => n.nodeName + ':' + JSON.stringify(n.nodeName==='#text'?n.data:n.innerHTML)).join(' | ')`;
// 1. Enter inside block
await page.evaluate(() => { const a = document.getElementById('a'); a.focus(); const t = a.firstChild.firstChild; getSelection().collapse(t, 2); });
await page.keyboard.press('Enter');
console.log('1 after Enter:', await page.evaluate(`(${ser})(document.getElementById('a'))`));
// 2. Delete at end of block 1 (merge)
await page.evaluate(() => { const a = document.getElementById('a'); const blk = a.firstChild; const r = document.createRange(); r.selectNodeContents(blk); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
await page.keyboard.press('Delete');
console.log('2 after Delete at block end:', await page.evaluate(`(${ser})(document.getElementById('a'))`));
await page.keyboard.press('Control+z');
console.log('2b after undo:', await page.evaluate(`(${ser})(document.getElementById('a'))`));
// 3. selection.toString across blocks vs Range.toString
await page.evaluate(() => { const a = document.getElementById('a'); const r = document.createRange(); r.selectNodeContents(a); getSelection().removeAllRanges(); getSelection().addRange(r); });
console.log('3 sel.toString:', JSON.stringify(await page.evaluate(() => getSelection().toString())), ' range.toString:', JSON.stringify(await page.evaluate(() => getSelection().getRangeAt(0).toString())));
// 4. type in A, type in B, undo in B twice: does A change?
await page.evaluate(() => { const a = document.getElementById('a'); a.focus(); const t = a.firstChild.firstChild; getSelection().collapse(t, 0); });
await page.keyboard.type('AAA');
await page.evaluate(() => { const b = document.getElementById('b'); b.focus(); getSelection().collapse(b.firstChild.firstChild, 2); });
await page.keyboard.type('BBB');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
console.log('4 after 2 undos in B: A=', JSON.stringify(await page.evaluate(() => document.getElementById('a').textContent)), ' B=', JSON.stringify(await page.evaluate(() => document.getElementById('b').textContent)), ' focus:', await page.evaluate(() => document.activeElement.id));
// 4b same with A hidden (display:none)
await page.evaluate(() => { document.getElementById('a').style.display='none'; const b = document.getElementById('b'); b.focus(); });
await page.keyboard.press('Control+z');
console.log('4b undo in B with A hidden: A=', JSON.stringify(await page.evaluate(() => document.getElementById('a').textContent)), ' B=', JSON.stringify(await page.evaluate(() => document.getElementById('b').textContent)));
// 5. trailing newline caret
await page.setContent(`<!doctype html><style>${css}</style><div id=a class=ed contenteditable=plaintext-only spellcheck=false><div>x\ny\n</div></div>`);
const rects = await page.evaluate(() => { const t = document.getElementById('a').firstChild.firstChild; const out=[]; for (const o of [0,2,4]) { const r = document.createRange(); r.setStart(t,o); r.collapse(true); const rr = r.getClientRects(); out.push([o, rr.length ? Math.round(rr[0].top) : null]); } return out; });
console.log('5 caret tops at offsets 0,2,4 (x\\ny\\n):', JSON.stringify(rects), 'blockHeight', await page.evaluate(() => document.getElementById('a').firstChild.getBoundingClientRect().height));
await page.evaluate(() => { const a=document.getElementById('a'); a.focus(); getSelection().collapse(a.firstChild.firstChild, 4); });
await page.keyboard.type('Z');
console.log('5b typed at end:', await page.evaluate(`(${ser})(document.getElementById('a'))`), 'height', await page.evaluate(() => document.getElementById('a').firstChild.getBoundingClientRect().height));
// 6. paste multi-line via insertText
await page.evaluate(() => { const a=document.getElementById('a'); a.focus(); getSelection().collapse(a.firstChild.firstChild, 1); document.execCommand('insertText', false, 'P1\nP2\r\nP3'); });
console.log('6 insertText multi-line:', await page.evaluate(`(${ser})(document.getElementById('a'))`));
// 7. select all + delete then type
await page.evaluate(() => { const a=document.getElementById('a'); a.focus(); document.execCommand('selectAll'); });
await page.keyboard.press('Delete');
console.log('7 after selectAll+Delete:', await page.evaluate(`(${ser})(document.getElementById('a'))`));
await page.keyboard.type('new');
console.log('7b typed:', await page.evaluate(`(${ser})(document.getElementById('a'))`));
console.log('8 Highlight API:', await page.evaluate(() => typeof Highlight !== 'undefined' && !!CSS.highlights));
await browser.close();
