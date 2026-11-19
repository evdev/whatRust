import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const source = fs.readFileSync(new URL('./schedule-pdf-preview.js', import.meta.url), 'utf8');
test('rejects unsupported inputs before reading or instantiating PDF.js', async () => {
  const window = {};
  vm.runInNewContext(source, { window, setTimeout, clearTimeout, Uint8Array });
  for (const file of [null, { size: 0, arrayBuffer() { throw Error('read'); } },
    { size: 21 * 1024 * 1024, arrayBuffer() { throw Error('read'); } }]) {
    await assert.rejects(window.__wrSchedulePdfPreview(file), /size limit/);
  }
  await assert.rejects(window.__wrSchedulePdfPreview({ size: 5,
    async arrayBuffer() { return new Uint8Array([1, 2, 3, 4, 5]).buffer; } }), /Invalid PDF/);
});

function fixture() {
  const content = '1 0 0 rg 20 20 200 300 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 1600] /Resources <<>> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /S /JavaScript /JS (globalThis.PDF_SCRIPT_RAN=true) >>',
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(data.length);
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = data.length;
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) data += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return data + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}

const edge = process.env.WR_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
test('real Edge renders locally with workers, network, fonts, and document scripts blocked',
  { skip: !fs.existsSync(edge), timeout: 40000 }, () => {
    const scratch = fs.realpathSync(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(scratch, 'wr-pdf-preview-'));
    const vendor = fs.readFileSync(new URL('./schedule-pdf-vendor.js', import.meta.url), 'utf8');
    const script = `${vendor}\n${source}\n
      window.fetch=()=>{throw Error('Network attempted')};
      window.Worker=class{constructor(){throw Error('Worker attempted')}};
      __wrSchedulePdfPreview(new File([${JSON.stringify(fixture())}], 'local.pdf'))
      .then(async blob=>{
        const bitmap=await createImageBitmap(blob);
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
        const pixel=[...ctx.getImageData(30,430,1,1).data];
        document.body.textContent='RESULT:'+JSON.stringify({type:blob.type,size:blob.size,
          width:bitmap.width,height:bitmap.height,scriptRan:!!window.PDF_SCRIPT_RAN,pixel});
      }).catch(e=>document.body.textContent='FAILED:'+e.stack);`;
    const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src 'none'; connect-src 'none'; font-src 'none'; img-src blob: data:"><body>WAIT<script>${script.replaceAll('</script', '<\\/script')}</script>`;
    const file = path.join(dir, 'preview.html');
    fs.writeFileSync(file, html);
    try {
      const output = execFileSync(edge, ['--headless', '--disable-gpu', '--disable-background-networking',
        `--user-data-dir=${path.join(dir, 'profile')}`, '--dump-dom', '--virtual-time-budget=15000',
        new URL(`file:///${file.replaceAll('\\', '/')}`).href],
      { encoding: 'utf8', windowsHide: true, timeout: 35000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const result = output.match(/RESULT:(\{[^<]+\})/);
      assert.ok(result, output.slice(-2000));
      const parsed = JSON.parse(result[1]);
      assert.equal(parsed.type, 'image/jpeg');
      assert.equal(parsed.width, 360);
      assert.equal(parsed.height, 480);
      assert.ok(parsed.size > 0 && parsed.size <= 256 * 1024);
      assert.equal(parsed.scriptRan, false);
      assert.ok(parsed.pixel[0] > 200 && parsed.pixel[1] < 40 && parsed.pixel[2] < 40,
        `Page artwork missing: ${parsed.pixel}`);
    } finally {
      // Edge can retain profile handles briefly on Windows; test artifacts are temporary.
      try {
        const resolved = fs.realpathSync(dir);
        if (path.dirname(resolved) === scratch && path.basename(resolved).startsWith('wr-pdf-preview-')) {
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  });
