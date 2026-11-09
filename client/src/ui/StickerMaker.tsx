// Make a sticker from a photo: the subject is cut out automatically on this
// phone, then you can add a caption and an outline, and save it to My stickers.

import { useEffect, useRef, useState } from 'preact/hooks';
import { getNav } from './nav';
import { Button, Spinner, confirmAction, toast } from './components';
import { composeSticker, cutOut, cutoutModelReady, wholePhoto, type StickerStyle } from '../lib/cutout';
import { addMySticker } from '../lib/mystickers';
import { t } from '../lib/i18n';

/** Opens the maker for a picked photo. Resolves with the new sticker id, or null. */
export function makeSticker(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (id: string | null) => { if (!done) { done = true; resolve(id); } };
    getNav().present((close) => <Maker file={file} close={async (id) => { finish(id); await close(); }} />, { variant: 'full', onClose: () => finish(null) });
  });
}

function Maker({ file, close }: { file: Blob; close: (id: string | null) => Promise<void> }) {
  const [cut, setCut] = useState<ImageData | null>(null);
  const [whole, setWhole] = useState<ImageData | null>(null);
  const [useWhole, setUseWhole] = useState(false);
  const [status, setStatus] = useState('');
  const [style, setStyle] = useState<StickerStyle>({ outline: true, text: '', textStyle: 'meme' });
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const started = useRef(false);

  const startCut = async () => {
    if (started.current) return;
    if (!cutoutModelReady() && !(await confirmAction({
      title: t('Cut out automatically?'),
      message: t('Haven finds the person or object in the photo and removes the background – right on this phone, the photo never leaves it. For this, a model (about 44 MB) is downloaded once.'),
      confirm: t('Download and cut out'),
    }))) {
      setUseWhole(true);
      return;
    }
    started.current = true;
    setStatus(t('Preparing…'));
    try {
      const img = await cutOut(file, (s) => setStatus(s.type === 'download' ? `${t('Downloading model')} ${s.pct}%` : t('Finding the subject…')));
      setCut(img);
      setUseWhole(false);
    } catch {
      toast(t('Could not cut out this photo. Using the whole photo.'), 'error');
      setUseWhole(true);
    } finally {
      setStatus('');
      started.current = false;
    }
  };

  useEffect(() => {
    wholePhoto(file).then(setWhole, () => {});
    startCut();
  }, []);

  // Live preview of the finished sticker.
  const source = useWhole ? whole : cut;
  useEffect(() => {
    if (!source) return;
    let alive = true;
    let url = '';
    const timer = setTimeout(() => {
      composeSticker(source, { ...style, outline: style.outline && !useWhole }).then((b) => {
        if (!alive) return;
        url = URL.createObjectURL(b);
        setPreview((old) => { if (old) URL.revokeObjectURL(old); return url; });
      }, () => {});
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [source, style, useWhole]);

  const save = async () => {
    if (!source) return;
    setSaving(true);
    try {
      const blob = await composeSticker(source, { ...style, outline: style.outline && !useWhole });
      const id = await addMySticker(blob);
      toast(t('Sticker saved'));
      await close(id);
    } catch {
      setSaving(false);
      toast(t('Could not save the sticker.'), 'error');
    }
  };

  return (
    <div class="sheet-page sticker-maker">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close(null)}>Cancel</button>
        <strong>New sticker</strong>
        <button class="nav-button bold" disabled={!source || saving || Boolean(status)} onClick={save}>Save</button>
      </div>
      <div class="sheet-scroll">
        <div class="maker-preview">
          {status ? (
            <div class="maker-status"><Spinner size={22} /><span>{status}</span></div>
          ) : preview ? (
            <img src={preview} alt="" draggable={false} />
          ) : (
            <Spinner size={22} />
          )}
        </div>
        <div class="sheet-content">
          <div class="maker-switch">
            <button class={!useWhole ? 'on' : ''} onClick={() => (cut ? setUseWhole(false) : startCut())} disabled={Boolean(status)}>Cut out</button>
            <button class={useWhole ? 'on' : ''} onClick={() => setUseWhole(true)} disabled={!whole}>Whole photo</button>
          </div>
          <input class="field" type="text" maxLength={40} placeholder="Text under the sticker (optional)" aria-label="Sticker text" value={style.text}
            onInput={(e) => setStyle((s) => ({ ...s, text: (e.target as HTMLInputElement).value }))} />
          <div class="maker-switch">
            {(['meme', 'pill', 'red'] as const).map((k) => (
              <button key={k} class={style.textStyle === k ? 'on' : ''} onClick={() => setStyle((s) => ({ ...s, textStyle: k }))}>
                {k === 'meme' ? 'Classic' : k === 'pill' ? 'Black' : 'Red'}
              </button>
            ))}
          </div>
          {!useWhole && (
            <label class="maker-check">
              <input type="checkbox" checked={style.outline} onChange={(e) => setStyle((s) => ({ ...s, outline: (e.target as HTMLInputElement).checked }))} />
              <span>White outline</span>
            </label>
          )}
          <Button onClick={save} loading={saving} disabled={!source || Boolean(status)}>Save sticker</Button>
          <p class="fine-print">The sticker is saved on this phone in My stickers. When you send it, it is end-to-end encrypted like a photo.</p>
        </div>
      </div>
    </div>
  );
}
