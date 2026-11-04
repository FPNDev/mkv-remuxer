import { childBoxes, findChild, payload } from './boxes.js';

/** One WebVTT cue of a text sample: its settings and its payload. */
export type TextCue = {
  settings: string;
  text: string;
};

const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
// The face style flags of a tx3g entry's default style record.
const TX3G_DEFAULT_FACE = 40;
const STYLE_RECORD_BYTES = 12;

/**
 * The cues of one sample of a tx3g or wvtt track. A tx3g sample keeps its
 * bold, italic and underline runs as WebVTT tags and drops other styling.
 */
export function textCues(entry: Buffer, sample: Buffer): TextCue[] {
  if (entry.toString('latin1', 4, 8) === 'wvtt') {
    return webVttCues(sample);
  }
  const cue = tx3gCue(entry, sample);

  return cue ? [cue] : [];
}

function tx3gCue(entry: Buffer, sample: Buffer): TextCue | undefined {
  if (sample.length < 2) {
    return undefined;
  }
  const length = sample.readUInt16BE(0);
  const bytes = sample.subarray(2, 2 + length);
  const text =
    bytes[0] === 0xfe && bytes[1] === 0xff
      ? Buffer.from(bytes.subarray(2, bytes.length & ~1))
          .swap16()
          .toString('utf16le')
      : bytes.toString('utf8');
  if (!text.trim()) {
    return undefined;
  }

  // Style records count characters, not bytes.
  const chars = Array.from(text);
  const faces = Array.from(
    { length: chars.length },
    () => entry[TX3G_DEFAULT_FACE] ?? 0,
  );
  for (const box of childBoxes(sample, 2 + length, sample.length)) {
    if (box.type !== 'styl') {
      continue;
    }
    const styles = payload(sample, box);
    const count = styles.readUInt16BE(0);
    for (
      let at = 2, i = 0;
      i < count && at + STYLE_RECORD_BYTES <= styles.length;
      at += STYLE_RECORD_BYTES, i++
    ) {
      const end = Math.min(styles.readUInt16BE(at + 2), chars.length);
      for (let c = styles.readUInt16BE(at); c < end; c++) {
        faces[c] = styles[at + 6]!;
      }
    }
  }

  let out = '';
  let open = 0;
  for (const [i, char] of chars.entries()) {
    const face = faces[i]! & (BOLD | ITALIC | UNDERLINE);
    if (face !== open) {
      out += closeTags(open) + openTags(face);
      open = face;
    }
    out += escapeText(char);
  }
  out += closeTags(open);

  return { settings: '', text: cueText(out) };
}

// A wvtt sample holds a vttc box per cue, or a vtte box when none shows.
function webVttCues(sample: Buffer): TextCue[] {
  const cues: TextCue[] = [];
  for (const box of childBoxes(sample, 0, sample.length)) {
    const payl = box.type === 'vttc' && findChild(sample, box, 'payl');
    if (!payl) {
      continue;
    }
    const text = cueText(payload(sample, payl).toString('utf8'));
    const sttg = findChild(sample, box, 'sttg');
    if (text) {
      cues.push({
        settings: sttg ? payload(sample, sttg).toString('utf8').trim() : '',
        text,
      });
    }
  }

  return cues;
}

function openTags(face: number): string {
  return (
    (face & BOLD ? '<b>' : '') +
    (face & ITALIC ? '<i>' : '') +
    (face & UNDERLINE ? '<u>' : '')
  );
}

function closeTags(face: number): string {
  return (
    (face & UNDERLINE ? '</u>' : '') +
    (face & ITALIC ? '</i>' : '') +
    (face & BOLD ? '</b>' : '')
  );
}

function escapeText(char: string): string {
  switch (char) {
    case '&':
      return '&amp;';
    case '<':
      return '&lt;';
    case '>':
      return '&gt;';
    default:
      return char;
  }
}

// A blank line would end the cue early.
function cueText(text: string): string {
  return text
    .replaceAll('\r', '')
    .replaceAll(/\n{2,}/gu, '\n')
    .trim();
}
