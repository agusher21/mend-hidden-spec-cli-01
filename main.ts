// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// Track move edits explicitly
interface MoveInfo {
  oldPath: string;
  newPath: string;
}

type Edit = (tree: Tree, moves: MoveInfo[]) => void;

// ============================================================
// Section 5: Line matching at three tiers
// ============================================================

function stripTrailing(line: string): string { return line.replace(/[ \t]+$/, ''); }
function stripBoth(line: string): string { return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''); }
function leadingWS(line: string): string { const m = line.match(/^[ \t]*/); return m ? m[0] : ''; }

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailing(line);
  return stripBoth(line);
}

function findOccurrences(fileLines: string[], oldLines: string[], tier: number): number[] {
  const oldKeys = oldLines.map((l) => tierKey(l, tier));
  const fileKeys = fileLines.map((l) => tierKey(l, tier));
  const occ: number[] = [];
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileKeys[i + j] !== oldKeys[j]) { ok = false; break; }
    }
    if (ok) occ.push(i);
  }
  return occ;
}

function findTier(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(fileLines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function fileLines(text: string): string[] {
  if (text === '') return [];
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const lines = text.split(br);
  if (text.endsWith(br)) lines.pop();
  return lines;
}

function joinLines(lines: string[], originalText: string): string {
  if (lines.length === 0) return '';
  const nl = originalText.indexOf('\n');
  const crlf = nl > 0 && originalText[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const ended = originalText !== '' && originalText.endsWith(br);
  return lines.join(br) + (ended ? br : '');
}

function applyReindent(newLines: string[], fileLinesArr: string[], matchPos: number, oldLines: string[], tier: number): string[] {
  if (tier !== 2 || oldLines.length === 0) return newLines.slice();
  const P = leadingWS(oldLines[0]);
  if (P === '') return newLines.slice();
  const F = leadingWS(fileLinesArr[matchPos]);
  return newLines.map((line) => {
    if (line === '' || line.trim() === '') return line;
    if (line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
}

// ============================================================
// Section 6: Unified diffs
// ============================================================

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  isMove: boolean;
  hunks: UnifiedHunk[];
  lineStart: number;
  lineEnd: number;
}

interface UnifiedHunk {
  A: number;
  B: number | undefined;
  C: number;
  D: number | undefined;
  body: string[];
  lineStart: number;
  lineEnd: number;
  noNewlineAtEnd: boolean;
}

function parseUnified(text: string, lines: string[], strict: boolean): { edits: Edit[]; moves: MoveInfo[] } {
  const sections: UnifiedSection[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const sec = parseSection(lines, i);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push(sec);
      i = sec.lineEnd + 1;
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const sec = parseSection(lines, i);
      if (sec === null) throw new Exit2(`error: parse ${i + 2}`);
      sections.push(sec);
      i = sec.lineEnd + 1;
    } else {
      i++;
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const moves: MoveInfo[] = [];
  const edits = sections.map((sec) => {
    if (sec.isMove) moves.push({ oldPath: sec.oldPath!, newPath: sec.newPath! });
    return unifiedEdit(sec, strict);
  });
  return { edits, moves };
}

function parseSection(lines: string[], start: number): UnifiedSection | null {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let i = start;

  if (lines[i].startsWith('diff --git ')) {
    const m = lines[i].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!m) return null;
    oldPath = m[1];
    newPath = m[2];
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      oldPath = parsePathLine(line);
      newPath = parsePathLine(lines[i + 1]);
      i += 2;
    } else if (line.startsWith('rename from ')) {
      oldPath = line.slice(12).trim();
      i++;
    } else if (line.startsWith('rename to ')) {
      newPath = line.slice(10).trim();
      i++;
    } else if (line === 'new file mode') {
      isCreate = true;
      i++;
    } else if (line === 'deleted file mode') {
      isDelete = true;
      i++;
    } else if (line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ') ||
               line.startsWith('similarity index ') || line.startsWith('dissimilarity index ') || line.startsWith('Index:')) {
      i++;
    } else if (line.startsWith('@@ ')) {
      break;
    } else {
      i++;
    }
  }

  if (oldPath !== null) oldPath = normalizePath(oldPath);
  if (newPath !== null) newPath = normalizePath(newPath);

  if (oldPath === '/dev/null') { isCreate = true; oldPath = null; }
  if (newPath === '/dev/null') { isDelete = true; newPath = null; }

  const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;

  const hunks: UnifiedHunk[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) break;
    if (line.startsWith('@@ ')) {
      const hunk = parseHunk(lines, i);
      if (hunk === null) throw new Exit2(`error: parse ${i + 1}`);
      hunks.push(hunk);
      i = hunk.lineEnd + 1;
    } else {
      i++;
    }
  }

  const lineEnd = i - 1;
  return { oldPath, newPath, isCreate, isDelete, isMove, hunks, lineStart: start, lineEnd };
}

function parsePathLine(line: string): string {
  const after = line.slice(4);
  const tabIdx = after.indexOf('\t');
  const path = tabIdx >= 0 ? after.slice(0, tabIdx) : after;
  return path.trim();
}

function normalizePath(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function parseHunk(lines: string[], start: number): UnifiedHunk | null {
  const line = lines[start];
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  const A = parseInt(m[1], 10);
  const B = m[2] ? parseInt(m[2], 10) : undefined;
  const C = parseInt(m[3], 10);
  const D = m[4] ? parseInt(m[4], 10) : undefined;

  const body: string[] = [];
  let noNewlineAtEnd = false;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) break;
    if (l.startsWith('@@ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      if (l.startsWith('\\')) {
        if (l.includes('No newline')) noNewlineAtEnd = true;
      } else {
        body.push(l);
      }
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { A, B, C, D, body, lineStart: start, lineEnd: i - 1, noNewlineAtEnd };
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree: Tree, _moves: MoveInfo[]) => {
    const { oldPath, newPath, isCreate, isDelete, isMove, hunks } = sec;
    const pathsToCheck: string[] = [];
    if (oldPath) pathsToCheck.push(oldPath);
    if (newPath) pathsToCheck.push(newPath);
    for (const p of pathsToCheck) { if (!safe(p)) throw new Fail('unsafe', p); }

    if (isCreate) {
      if (newPath === null) throw new Fail('exists', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const newLines: string[] = [];
      for (const hunk of hunks) {
        for (const bl of hunk.body) {
          if (bl.startsWith('+')) newLines.push(bl.slice(1));
          else if (bl.startsWith(' ') || bl === '') newLines.push(bl === '' ? '' : bl.slice(1));
        }
      }
      let endsWithNewline = true;
      if (hunks.length > 0 && hunks[hunks.length - 1].noNewlineAtEnd) endsWithNewline = false;
      const text = newLines.join('\n') + (endsWithNewline ? '\n' : '');
      tree.now.set(newPath, text);
      return;
    }

    if (isDelete) {
      if (oldPath === null) throw new Fail('missing', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }

    const path = oldPath ?? newPath!;
    if (path === null) throw new Fail('missing', '');
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);

    if (isMove) {
      if (newPath === null) throw new Fail('missing', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    }

    let fileLinesArr = fileLines(before);
    let d = 0;
    let lastHunkNoNewline = false;

    for (const hunk of hunks) {
      // Build O (context + old) and find match
      const O: string[] = [];
      for (const bl of hunk.body) {
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-')) {
          O.push(bl === '' ? '' : (bl.startsWith('-') ? bl.slice(1) : bl.slice(1)));
        }
      }
      const oLen = O.length;

      if (oLen === 0) {
        const insertAfter = Math.min(hunk.A + d, fileLinesArr.length);
        const N: string[] = [];
        for (const bl of hunk.body) {
          if (bl.startsWith('+') || bl.startsWith(' ') || bl === '') {
            N.push(bl === '' ? '' : bl.slice(1));
          }
        }
        const newN = applyReindent(N, fileLinesArr, insertAfter, [], 0);
        fileLinesArr.splice(insertAfter, 0, ...newN);
        d += N.length;
        lastHunkNoNewline = hunk.noNewlineAtEnd;
        continue;
      }

      const res = findTier(fileLinesArr, O, strict);
      if (res === null) throw new Fail('no-match', path);
      const tier = res.tier;
      const occ = res.occ;

      const target = hunk.A - 1 + d;
      let best = occ[0];
      let bestDist = Math.abs(occ[0] - target);
      for (const pos of occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist || (dist === bestDist && pos < best)) { best = pos; bestDist = dist; }
      }
      const matchPos = best;

      // Build replacement by walking the body
      const P = leadingWS(O[0]);
      const F = leadingWS(fileLinesArr[matchPos]);
      const replacement: string[] = [];
      let fileIdx = matchPos;
      for (const bl of hunk.body) {
        if (bl === '' || bl.startsWith(' ')) {
          // Context line: use file's line
          replacement.push(fileLinesArr[fileIdx]);
          fileIdx++;
        } else if (bl.startsWith('-')) {
          // Old line: skip
          fileIdx++;
        } else if (bl.startsWith('+')) {
          // New line: use patch line with reindent at tier 2
          let outLine = bl.slice(1);
          if (tier === 2 && P !== '' && outLine !== '' && outLine.trim() !== '' && outLine.startsWith(P)) {
            outLine = F + outLine.slice(P.length);
          }
          replacement.push(outLine);
        }
      }

      fileLinesArr.splice(matchPos, oLen, ...replacement);
      d += replacement.length - oLen;
      lastHunkNoNewline = hunk.noNewlineAtEnd;
    }

    let endedWithNewline = before !== '' && (before.endsWith('\n') || before.endsWith('\r\n'));
    if (lastHunkNoNewline) endedWithNewline = false;

    const br = (before.includes('\r\n') ? '\r\n' : '\n');
    const newText = fileLinesArr.length === 0 ? '' : fileLinesArr.join(br) + (endedWithNewline ? br : '');
    tree.now.set(path, newText);

    if (isMove) {
      tree.now.set(newPath!, tree.now.get(path)!);
      tree.now.set(path, null);
    }
  };
}

function splitHunk(hunk: UnifiedHunk): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const bl of hunk.body) {
    if (bl === '' || bl.startsWith(' ')) { O.push(bl === '' ? '' : bl.slice(1)); N.push(bl === '' ? '' : bl.slice(1)); }
    else if (bl.startsWith('-')) O.push(bl.slice(1));
    else if (bl.startsWith('+')) N.push(bl.slice(1));
  }
  return { O, N };
}

// ============================================================
// Section 7: SEARCH/REPLACE blocks
// ============================================================

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLineNum: number;
}

function parseSearchReplace(text: string, lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;

  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const l = lines[j];
        const trimmed = l.trim();
        if (trimmed !== '' && !trimmed.startsWith('```')) { path = trimmed; break; }
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLineNum + 1}`);
        path = prevPath;
      }

      let eqIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '=======') { eqIdx = j; break; }
      }
      if (eqIdx === -1) throw new Exit2(`error: parse ${searchLineNum + 1}`);

      let repIdx = -1;
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') { repIdx = j; break; }
      }
      if (repIdx === -1) throw new Exit2(`error: parse ${searchLineNum + 1}`);

      const oldLines: string[] = [];
      for (let j = i + 1; j < eqIdx; j++) oldLines.push(lines[j]);
      const newLines: string[] = [];
      for (let j = eqIdx + 1; j < repIdx; j++) newLines.push(lines[j]);

      blocks.push({ path, oldLines, newLines, searchLineNum });
      prevPath = path;
      prevReplaceEnd = repIdx;
      i = repIdx + 1;
    } else {
      i++;
    }
  }

  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(block: SRBlock, strict: boolean): Edit {
  return (tree: Tree, _moves: MoveInfo[]) => {
    const { path, oldLines, newLines } = block;
    if (!safe(path)) throw new Fail('unsafe', path);

    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.join('\n') + '\n');
      return;
    }

    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);

    const fileLinesArr = fileLines(before);
    const res = findTier(fileLinesArr, oldLines, strict);
    if (res === null) throw new Fail('no-match', path);
    if (res.occ.length > 1) throw new Fail('ambiguous', path);

    const matchPos = res.occ[0];
    const tier = res.tier;
    const replacement = applyReindent(newLines, fileLinesArr, matchPos, oldLines, tier);
    fileLinesArr.splice(matchPos, oldLines.length, ...replacement);
    tree.now.set(path, joinLines(fileLinesArr, before));
  };
}

// ============================================================
// Section 8: V4A patches
// ============================================================

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[]; // for Add File
  chunks: V4AChunk[];
  lineStart: number;
  lineEnd: number;
}

interface V4AChunk {
  anchor: string | null;
  body: string[];
  isEOF: boolean;
  lineStart: number;
  lineEnd: number;
}

function parseV4A(text: string, lines: string[], strict: boolean): { edits: Edit[]; moves: MoveInfo[] } {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank].trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank >= 0 ? firstNonBlank + 1 : 1}`);
  }

  const lastNonBlank = lines.reduce((acc, l, i) => (!blank(l) ? i : acc), -1);
  if (lastNonBlank < 0 || lines[lastNonBlank].trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;

  while (i < lastNonBlank) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      sections.push(parseV4AAddFile(lines, i, lastNonBlank));
      i = sections[sections.length - 1].lineEnd + 1;
    } else if (line.startsWith('*** Delete File: ')) {
      sections.push(parseV4ADeleteFile(lines, i, lastNonBlank));
      i = sections[sections.length - 1].lineEnd + 1;
    } else if (line.startsWith('*** Update File: ')) {
      sections.push(parseV4AUpdateFile(lines, i, lastNonBlank));
      i = sections[sections.length - 1].lineEnd + 1;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const moves: MoveInfo[] = [];
  const edits = sections.map((sec) => {
    if (sec.type === 'update' && sec.moveTo !== null) {
      moves.push({ oldPath: sec.path, newPath: sec.moveTo });
    }
    return v4aEdit(sec, strict);
  });
  return { edits, moves };
}

function parseV4AAddFile(lines: string[], start: number, endLimit: number): V4ASection {
  const path = lines[start].slice(14).trim();
  const addLines: string[] = [];
  let i = start + 1;
  for (; i <= endLimit; i++) {
    const l = lines[i];
    if (l.startsWith('*** ')) break;
    if (l.startsWith('+')) addLines.push(l.slice(1));
    else if (l === '') addLines.push('');
    else throw new Exit2(`error: parse ${i + 1}`);
  }
  while (i <= endLimit && blank(lines[i])) i++;
  return { type: 'add', path, moveTo: null, addLines, chunks: [], lineStart: start, lineEnd: i - 1 };
}

function parseV4ADeleteFile(lines: string[], start: number, endLimit: number): V4ASection {
  const path = lines[start].slice(16).trim();
  let i = start + 1;
  while (i <= endLimit && blank(lines[i])) i++;
  return { type: 'delete', path, moveTo: null, addLines: [], chunks: [], lineStart: start, lineEnd: i - 1 };
}

function parseV4AUpdateFile(lines: string[], start: number, endLimit: number): V4ASection {
  const path = lines[start].slice(16).trim();
  let moveTo: string | null = null;
  let i = start + 1;

  if (i <= endLimit && lines[i].startsWith('*** Move to: ')) {
    moveTo = lines[i].slice(13).trim();
    i++;
  }

  const chunks: V4AChunk[] = [];

  while (i <= endLimit) {
    const l = lines[i];
    if (blank(l)) { i++; continue; }
    if (l === '*** End of File') { /* handled in chunk */ break; }
    if (l.startsWith('*** ')) break;

    const chunk = parseV4AChunk(lines, i, endLimit);
    if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
    chunks.push(chunk);
    i = chunk.lineEnd + 1;
  }

  if (chunks.length === 0 && moveTo === null) {
    throw new Exit2(`error: parse ${start + 1}`);
  }

  while (i <= endLimit && blank(lines[i])) i++;
  return { type: 'update', path, moveTo, addLines: [], chunks, lineStart: start, lineEnd: i - 1 };
}

function parseV4AChunk(lines: string[], start: number, endLimit: number): V4AChunk | null {
  let anchor: string | null = null;
  let i = start;

  if (!lines[i].startsWith('@@')) {
    anchor = null;
  } else {
    const after = lines[i].slice(2).trim();
    anchor = after === '' ? null : after;
    i++;
  }

  const body: string[] = [];
  let isEOF = false;

  for (; i <= endLimit; i++) {
    const l = lines[i];
    if (l === '*** End of File') { isEOF = true; i++; break; }
    if (l.startsWith('*** ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      body.push(l);
    } else {
      return null;
    }
  }

  // Strip trailing empty context lines (blank lines at end of chunk)
  while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) {
    body.pop();
  }

  return { anchor, body, isEOF, lineStart: start, lineEnd: i - 1 };
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree: Tree, _moves: MoveInfo[]) => {
    const { type, path, moveTo, addLines, chunks } = sec;

    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);

    if (type === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.join('\n') + '\n');
      return;
    }

    if (type === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }

    // update
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);

    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

    let fileLinesArr = fileLines(before);
    let cursor = 0;

    for (const chunk of chunks) {
      const { O, N } = splitV4AChunk(chunk);

      if (chunk.anchor !== null) {
        // Find anchor at first tier where it matches, at or after cursor
        const anchorLine = chunk.anchor;
        let anchorPos = -1;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier; t++) {
          const key = tierKey(anchorLine, t);
          for (let pos = cursor; pos < fileLinesArr.length; pos++) {
            if (tierKey(fileLinesArr[pos], t) === key) {
              anchorPos = pos;
              break;
            }
          }
          if (anchorPos >= 0) break;
        }
        if (anchorPos < 0) throw new Fail('no-match', path);
        cursor = anchorPos + 1;
      }

      if (O.length === 0) {
        const insertPos = chunk.isEOF ? fileLinesArr.length : cursor;
        const newN = applyReindent(N, fileLinesArr, insertPos, [], 0);
        fileLinesArr.splice(insertPos, 0, ...newN);
        cursor = insertPos + newN.length;
        continue;
      }

      // Find O at or after cursor
      let matchPos = -1;
      let matchTier = -1;
      const maxTier = strict ? 0 : 2;
      for (let t = 0; t <= maxTier; t++) {
        const occ = findOccurrences(fileLinesArr.slice(cursor), O, t);
        if (occ.length > 0) {
          if (chunk.isEOF) {
            for (const pos of occ) {
              if (pos + O.length === fileLinesArr.length - cursor) { matchPos = cursor + pos; matchTier = t; break; }
            }
            if (matchPos >= 0) break;
          } else {
            matchPos = cursor + occ[0];
            matchTier = t;
            break;
          }
        }
      }
      if (matchPos < 0) throw new Fail('no-match', path);

      // Build replacement by walking the body (like unified)
      const P = leadingWS(O[0]);
      const F = leadingWS(fileLinesArr[matchPos]);
      const replacement: string[] = [];
      let fileIdx = matchPos;
      for (const bl of chunk.body) {
        if (bl === '' || bl.startsWith(' ')) {
          // Context line: use file's line
          replacement.push(fileLinesArr[fileIdx]);
          fileIdx++;
        } else if (bl.startsWith('-')) {
          // Old line: skip
          fileIdx++;
        } else if (bl.startsWith('+')) {
          // New line: use patch line with reindent at tier 2
          let outLine = bl.slice(1);
          if (matchTier === 2 && outLine !== '' && outLine.trim() !== '') {
            if (P === '') {
              // P empty: prepend F
              outLine = F + outLine;
            } else if (outLine.startsWith(P)) {
              outLine = F + outLine.slice(P.length);
            }
          }
          replacement.push(outLine);
        }
      }

      fileLinesArr.splice(matchPos, O.length, ...replacement);
      cursor = matchPos + replacement.length;
    }

    const newText = joinLines(fileLinesArr, before);
    if (moveTo !== null) {
      tree.now.set(moveTo, newText);
      tree.now.set(path, null);
    } else {
      tree.now.set(path, newText);
    }
  };
}

function splitV4AChunk(chunk: V4AChunk): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const bl of chunk.body) {
    if (bl.startsWith(' ')) { O.push(bl.slice(1)); N.push(bl.slice(1)); }
    else if (bl.startsWith('-')) O.push(bl.slice(1));
    else if (bl.startsWith('+')) N.push(bl.slice(1));
    else if (bl === '') { O.push(''); N.push(''); }
  }
  return { O, N };
}

// ============================================================
// Section 9: JSON edits (from starter)
// ============================================================

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => { if (!safe(p)) throw new Fail('unsafe', p); if (tree.get(p) !== null) throw new Fail('exists', p); tree.now.set(p, text); };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): { edits: Edit[]; moves: MoveInfo[] } {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) { const e = jsonEdit(x); if (e === null) throw new Exit2(`error: parse ${first + 1}`); edits.push(e); }
    return { edits, moves: [] };
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return { edits, moves: [] };
}

// ============================================================
// Main run function
// ============================================================

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  let moves: MoveInfo[] = [];
  try {
    if (kind === 'json') { const r = jsonEdits(text, lines); edits = r.edits; moves = r.moves; }
    else if (kind === 'unified') { const r = parseUnified(text, lines, strict); edits = r.edits; moves = r.moves; }
    else if (kind === 'search-replace') { edits = parseSearchReplace(text, lines, strict); moves = []; }
    else if (kind === 'v4a') { const r = parseV4A(text, lines, strict); edits = r.edits; moves = r.moves; }
    else { edits = []; moves = []; }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try { edit(tree, moves); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // Build output rows with explicit move tracking
  const rows: string[] = [];
  const handledPaths = new Set<string>();
  for (const { oldPath, newPath } of moves.sort((a, b) => Buffer.from(a.newPath).compare(Buffer.from(b.newPath)))) {
    const wasOld = tree.original(oldPath);
    const nowOld = tree.now.get(oldPath);
    const wasNew = tree.original(newPath);
    const nowNew = tree.now.get(newPath);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push(`R ${oldPath} -> ${newPath}`);
      handledPaths.add(oldPath);
      handledPaths.add(newPath);
    }
  }
  const changedPaths = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changedPaths.add(p);
  }
  for (const p of [...changedPaths].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
    if (handledPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }

  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}