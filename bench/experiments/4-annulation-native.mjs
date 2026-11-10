import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page.setContent(`<!doctype html><textarea id=a></textarea><textarea id=b></textarea><script>
window.log=[]; for (const id of ['a','b']) { const t=document.getElementById(id);
 t.addEventListener('beforeinput', e => { log.push(id+':before:'+e.inputType+':'+JSON.stringify(e.data)+':'+t.selectionStart+'-'+t.selectionEnd); if (window.block && e.inputType.startsWith('history')) e.preventDefault(); });
 t.addEventListener('input', e => log.push(id+':input:'+e.inputType+':'+t.selectionStart+':'+JSON.stringify(t.value))); }
</script>`);
await page.click('#a'); await page.keyboard.type('AAA');
await page.click('#b'); await page.keyboard.type('BBB');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
console.log('native undo: a=', await page.$eval('#a', t => t.value), 'b=', await page.$eval('#b', t => t.value), 'focus=', await page.evaluate(() => document.activeElement.id));
await page.evaluate(() => { window.block = true; window.log = []; });
await page.keyboard.type('C'); await page.keyboard.press('Control+z');
console.log('blocked undo: b=', await page.$eval('#b', t => t.value), 'log=', await page.evaluate(() => log.join(' || ')));
// setRangeText
await page.evaluate(() => { const t = document.getElementById('b'); t.value='hello world'; t.setSelectionRange(5,5); t.setRangeText(' big', 5, 5, 'end'); });
console.log('setRangeText:', await page.$eval('#b', t => t.value + ' sel=' + t.selectionStart));
// IME composition via CDP
const cdp = await page.context().newCDPSession(page);
await page.evaluate(() => { const t = document.getElementById('b'); t.focus(); t.value='x'; t.setSelectionRange(1,1); window.log=[]; });
await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 });
await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
await cdp.send('Input.insertText', { text: '漢' });
console.log('IME:', await page.$eval('#b', t => t.value), await page.evaluate(() => log.join(' || ')));
// Dead key on French layout produces composition? simulate é via insertText
// large value costs
const r = await page.evaluate(() => { const t = document.getElementById('a'); const line='Lorem ipsum dolor sit amet, consectetur adipiscing elit 0123456789\n'; const s=line.repeat(Math.ceil(3*1048576/line.length)); t.value=s; t.offsetHeight;
  let a=performance.now(); const v=t.value; const read=performance.now()-a;
  const v2 = v.slice(0, 1500000) + 'Z' + v.slice(1500000);
  a=performance.now(); let i=0; const n=Math.min(v.length,v2.length); while(i<n && v.charCodeAt(i)===v2.charCodeAt(i)) i++; let j=0; while(j<n-i && v.charCodeAt(v.length-1-j)===v2.charCodeAt(v2.length-1-j)) j++; const diff=performance.now()-a;
  a=performance.now(); t.setRangeText('Q', 10, 10, 'end'); t.offsetHeight; const srt=performance.now()-a;
  return {readMs:+read.toFixed(2), diffMs:+diff.toFixed(2), prefix:i, setRangeTextMs:+srt.toFixed(2)}; });
console.log('3MB costs:', JSON.stringify(r));
await browser.close();
