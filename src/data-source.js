/*
 * data-source.js
 * 資料内の <script> の先頭付近にある「const 名前 = [ … ];」形式のデータを見つけ、
 * 値の位置を記録して、変えた値だけを書き換える。
 * 読めるのは 文字・数字・true/false・null と、それらの一覧 [ ] / まとまり { } だけ。
 * 計算式や関数呼び出しが混ざったものはデータとして扱わない。
 */
(function (root) {
  'use strict';

  var H = root.HedHtml || (typeof require !== 'undefined' ? require('./html-source.js') : null);

  function Fail(msg) { this.message = msg; }

  // ---------------------------------------------------------------------------
  // 値の読み取り（位置つき）
  // ---------------------------------------------------------------------------
  function LiteralParser(text, base) { this.s = text; this.i = 0; this.base = base; }
  LiteralParser.prototype = {
    ws: function () {
      var s = this.s;
      for (;;) {
        while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
        if (s.startsWith('//', this.i)) { var e = s.indexOf('\n', this.i); this.i = e < 0 ? s.length : e; continue; }
        if (s.startsWith('/*', this.i)) { var c = s.indexOf('*/', this.i + 2); if (c < 0) throw new Fail('comment'); this.i = c + 2; continue; }
        break;
      }
    },
    value: function () {
      this.ws();
      var s = this.s, c = s[this.i], start = this.i;
      if (c === '[') return this.array();
      if (c === '{') return this.object();
      if (c === '"' || c === "'" || c === '`') { var v = this.string(); return { t: 'str', v: v.v, q: c, start: this.base + start, end: this.base + this.i }; }
      var m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(this.i, this.i + 40));
      if (m) { this.i += m[0].length; return { t: 'num', v: Number(m[0]), raw: m[0], start: this.base + start, end: this.base + this.i }; }
      var w = /^[A-Za-z_$][\w$]*/.exec(s.slice(this.i, this.i + 40));
      if (w) {
        var word = w[0];
        if (word === 'true' || word === 'false') { this.i += word.length; return { t: 'bool', v: word === 'true', start: this.base + start, end: this.base + this.i }; }
        if (word === 'null') { this.i += 4; return { t: 'null', v: null, start: this.base + start, end: this.base + this.i }; }
      }
      throw new Fail('value');
    },
    string: function () {
      var s = this.s, q = s[this.i], out = '';
      this.i++;
      while (this.i < s.length) {
        var c = s[this.i];
        if (c === q) { this.i++; return { v: out }; }
        if (q === '`' && c === '$' && s[this.i + 1] === '{') throw new Fail('template');
        if (q !== '`' && c === '\n') throw new Fail('newline');
        if (c === '\\') {
          var d = s[this.i + 1];
          var map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
          if (map[d] !== undefined) { out += map[d]; this.i += 2; continue; }
          if (d === 'u') {
            var mu = /^\\u\{([0-9a-fA-F]+)\}|^\\u([0-9a-fA-F]{4})/.exec(s.slice(this.i, this.i + 12));
            if (!mu) throw new Fail('escape');
            out += String.fromCodePoint(parseInt(mu[1] || mu[2], 16)); this.i += mu[0].length; continue;
          }
          if (d === 'x') { out += String.fromCharCode(parseInt(s.substr(this.i + 2, 2), 16)); this.i += 4; continue; }
          if (d === '\n') { this.i += 2; continue; }
          out += d; this.i += 2; continue;
        }
        out += c; this.i++;
      }
      throw new Fail('unterminated');
    },
    array: function () {
      var start = this.i; this.i++;
      var node = { t: 'arr', items: [], commas: [], start: this.base + start, end: 0 };
      for (;;) {
        this.ws();
        if (this.s[this.i] === ']') { this.i++; break; }
        node.items.push(this.value());
        node.commas.push(-1);
        this.ws();
        if (this.s[this.i] === ',') { node.commas[node.commas.length - 1] = this.base + this.i; this.i++; continue; }
        if (this.s[this.i] === ']') { this.i++; break; }
        throw new Fail('array');
      }
      node.end = this.base + this.i;
      return node;
    },
    object: function () {
      var start = this.i; this.i++;
      var node = { t: 'obj', props: [], start: this.base + start, end: 0 };
      for (;;) {
        this.ws();
        if (this.s[this.i] === '}') { this.i++; break; }
        var ks = this.i, key;
        var c = this.s[this.i];
        if (c === '"' || c === "'") key = this.string().v;
        else {
          var m = /^[A-Za-z_$][\w$]*|^\d+/.exec(this.s.slice(this.i, this.i + 80));
          if (!m) throw new Fail('key');
          key = m[0]; this.i += m[0].length;
        }
        var ke = this.i;
        this.ws();
        if (this.s[this.i] !== ':') throw new Fail('colon');
        this.i++;
        var val = this.value();
        var prop = { key: key, keyStart: this.base + ks, keyEnd: this.base + ke, value: val, comma: -1 };
        node.props.push(prop);
        this.ws();
        if (this.s[this.i] === ',') { prop.comma = this.base + this.i; this.i++; continue; }
        if (this.s[this.i] === '}') { this.i++; break; }
        throw new Fail('object');
      }
      node.end = this.base + this.i;
      return node;
    }
  };

  // ---------------------------------------------------------------------------
  // データの一覧を探す
  // ---------------------------------------------------------------------------
  function findDatasets(doc) {
    var src = doc.src;
    var out = [];
    var seen = {};
    doc.elements.forEach(function (el) {
      if (el.tag !== 'script' || H.getAttr(el, 'src')) return;
      var type = H.getAttr(el, 'type');
      if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type.value.trim())) return;
      var text = src.slice(el.contentStart, el.contentEnd);
      var base = el.contentStart;
      var re = /^(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*/gm;
      var m;
      while ((m = re.exec(text))) {
        var name = m[1];
        var p = new LiteralParser(text, base);
        p.i = m.index + m[0].length;
        var node;
        try { node = p.value(); } catch (e) { if (e instanceof Fail) continue; throw e; }
        // 値の後ろが「;」か改行で終わっていること（後ろに .map() などが続くものは除外）
        var rest = text.slice(p.i);
        var tail = /^[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)?[ \t]*(;|\n|$)/.exec(rest);
        if (!tail) continue;
        if (seen[name]) continue;
        seen[name] = true;
        out.push({
          src: src,
          name: name,
          node: node,
          declStart: base + m.index,
          kind: kindOf(node),
          description: describe(text, m.index, base + m.index, src)
        });
      }
    });
    return out;
  }

  function kindOf(node) {
    if (node.t === 'arr') {
      if (node.items.length && node.items.every(function (x) { return x.t === 'obj'; })) return 'rows';
      if (node.items.every(function (x) { return x.t !== 'obj' && x.t !== 'arr'; })) return 'list';
      return 'mixed';
    }
    if (node.t === 'obj') return 'map';
    return 'value';
  }

  // データ直前のコメントを説明として拾う。
  // 間に1行で終わる別のデータ（例: const GANTT_START = "…";）があっても飛ばして上へ読む。
  function describe(text, localDecl, absDecl, src) {
    var lines = text.slice(0, localDecl).split('\n');
    lines.pop(); // 宣言行の手前の部分
    var picked = [];
    var declLineEnd = text.indexOf('\n', localDecl);
    var declLine = text.slice(localDecl, declLineEnd < 0 ? text.length : declLineEnd);
    var trailing = /;\s*\/\/\s?(.*)$/.exec(declLine) || /^[^\n]*?[\]}"'\d]\s*\/\/\s?(.*)$/.exec(declLine);
    for (var k = lines.length - 1; k >= 0; k--) {
      var ln = lines[k].trim();
      if (!ln) break;
      if (/^\/\//.test(ln)) { picked.unshift(ln.replace(/^\/\/\s?/, '')); continue; }
      if (/\*\/$/.test(ln)) {
        var block = [];
        while (k >= 0) {
          var b = lines[k].trim();
          block.unshift(b.replace(/^\/\*+\s?/, '').replace(/\s?\*+\/$/, '').replace(/^\*\s?/, ''));
          if (/^\/\*/.test(b)) break;
          k--;
        }
        picked = block.concat(picked);
        continue;
      }
      if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=.*;\s*(\/\/.*)?$/.test(ln)) continue; // 1行のデータは飛ばす
      break;
    }
    picked = picked
      .map(function (l) { return l.replace(/-{3,}/g, '').trim(); })
      .filter(function (l) { return l.length > 0; });
    if (trailing && trailing[1]) picked.push(trailing[1].trim());
    return picked.join('\n');
  }

  // ---------------------------------------------------------------------------
  // 値の取り出し・パス
  // ---------------------------------------------------------------------------
  function plain(node) {
    if (!node) return undefined;
    if (node.t === 'arr') return node.items.map(plain);
    if (node.t === 'obj') { var o = {}; node.props.forEach(function (p) { o[p.key] = plain(p.value); }); return o; }
    return node.v;
  }

  function prop(node, key) {
    if (!node || node.t !== 'obj') return null;
    for (var k = 0; k < node.props.length; k++) if (node.props[k].key === key) return node.props[k];
    return null;
  }

  // path: ['3', 'phases', '0', 'label'] のように、一覧の番号と項目名の並び
  function resolve(ds, path) {
    var node = ds.node, parent = null, last = null;
    for (var k = 0; k < path.length; k++) {
      parent = node; last = path[k];
      if (!node) return { node: null, parent: parent, key: last };
      if (node.t === 'arr') node = node.items[Number(last)] || null;
      else if (node.t === 'obj') { var p = prop(node, String(last)); node = p ? p.value : null; }
      else return { node: null, parent: parent, key: last };
    }
    return { node: node, parent: parent, key: last };
  }

  // 一覧（行）の列名：最初に現れた順にすべての行の項目名を集める
  function columnsOf(arrNode) {
    var cols = [];
    arrNode.items.forEach(function (it) {
      if (it.t !== 'obj') return;
      it.props.forEach(function (p) { if (cols.indexOf(p.key) < 0) cols.push(p.key); });
    });
    return cols;
  }

  // 表示に出ている文字との照合用に、1件の中の文字の値をすべて集める（2文字以上）
  function stringsOf(node, out) {
    out = out || [];
    if (!node) return out;
    if (node.t === 'str') { var v = node.v.trim(); if (v.length >= 2) out.push(v); }
    else if (node.t === 'arr') node.items.forEach(function (x) { stringsOf(x, out); });
    else if (node.t === 'obj') node.props.forEach(function (p) { stringsOf(p.value, out); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // 書き戻し
  // ---------------------------------------------------------------------------
  function quoteString(v, q) {
    if (q === "'") return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
    if (q === '`') return '`' + v.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
    return JSON.stringify(v);
  }

  var NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  // 入力欄の文字を、元の値の種類に合わせて書き戻す文字列にする
  function literalFor(text, orig, hint) {
    var t = String(text);
    if (orig && orig.t === 'num') return NUM_RE.test(t.trim()) ? t.trim() : quoteString(t, '"');
    if (orig && orig.t === 'bool') { if (t.trim() === 'true' || t.trim() === 'false') return t.trim(); return quoteString(t, '"'); }
    if (orig && orig.t === 'null') {
      if (t === '') return 'null';
      if (hint === 'num' && NUM_RE.test(t.trim())) return t.trim();
      return quoteString(t, '"');
    }
    if (orig && orig.t === 'str') {
      if (hint === 'num' && NUM_RE.test(t.trim())) return t.trim();
      if (hint === 'bool' && (t.trim() === 'true' || t.trim() === 'false')) return t.trim();
      return quoteString(t, orig.q);
    }
    if (hint === 'num' && NUM_RE.test(t.trim())) return t.trim();
    if (hint === 'bool' && (t.trim() === 'true' || t.trim() === 'false')) return t.trim();
    return quoteString(t, '"');
  }

  // 同じ項目名の他の行の値から、数字の列かどうかなどを推し量る（書き戻しの種類の参考）
  function columnHint(arrNode, key) {
    var kinds = {};
    arrNode.items.forEach(function (it) { var p = prop(it, key); if (p && p.value.t !== 'null') kinds[p.value.t] = true; });
    var ks = Object.keys(kinds);
    return ks.length === 1 ? ks[0] : null;
  }

  // 同じ項目名の値を、一覧の何件目かを問わず集めて種類を推し量る。
  // 例: ['12','phases','0','months'] なら、すべての行の phases のすべての months を見る
  function shapeHint(ds, path, self) {
    var kinds = {};
    (function walk(node, k) {
      if (!node) return;
      if (k === path.length) {
        if (node !== self && node.t !== 'null' && node.t !== 'arr' && node.t !== 'obj') kinds[node.t] = true;
        return;
      }
      if (node.t === 'arr') node.items.forEach(function (it) { walk(it, k + 1); });
      else if (node.t === 'obj') { var p = prop(node, String(path[k])); if (p) walk(p.value, k + 1); }
    })(ds.node, 0);
    var ks = Object.keys(kinds);
    return ks.length === 1 ? ks[0] : null;
  }

  // 表示用の文字（入力欄に入れる文字）
  function displayText(node) {
    if (!node) return '';
    if (node.t === 'null') return '';
    if (node.t === 'str') return node.v;
    if (node.t === 'num') return node.raw;
    if (node.t === 'bool') return String(node.v);
    return '';
  }

  function multiline(src, node) { return src.slice(node.start, node.end).indexOf('\n') >= 0; }

  var edits = {
    // 値を書き換える。項目が無ければ追加する
    setValue: function (src, ds, path, text) {
      var r = resolve(ds, path);
      if (r.node) {
        if (r.node.t === 'arr' || r.node.t === 'obj') throw new Error('一覧やまとまりは直接書き換えできません');
        var hint = shapeHint(ds, path, r.node);
        var lit = literalFor(text, r.node, hint);
        if (lit === ds.src.slice(r.node.start, r.node.end)) return [];
        return [{ start: r.node.start, end: r.node.end, text: lit }];
      }
      if (r.parent && r.parent.t === 'obj') {
        if (text === '') return [];
        return [addKeyPatch(src, r.parent, String(r.key), literalFor(text, null, shapeHint(ds, path, null)))];
      }
      throw new Error('書き換える場所が見つかりません');
    },

    // 一覧に1件追加する（afterIndex の次に）。見た目はその1件を手本にし、値は空にする
    // template: 0件の一覧に足すときの手本 { node: 手本の1件, arr: 手本の入っている一覧 }
    addItem: function (src, ds, arrPath, afterIndex, template) {
      var arr = resolve(ds, arrPath).node;
      if (!arr || arr.t !== 'arr') throw new Error('一覧が見つかりません');
      if (!arr.items.length) {
        if (!template) throw new Error('1件もない一覧には、手本がないため追加できません');
        return [{ start: arr.start + 1, end: arr.end - 1, text: blankCopy(src, template.node, template.arr) }];
      }
      var idx = Math.min(Math.max(afterIndex, 0), arr.items.length - 1);
      var item = arr.items[idx];
      var text = blankCopy(src, item, arr);
      var ml = H.util.startsLine(src, item.start);
      var indent = H.util.indentAt(src, item.start);
      var comma = arr.commas[idx];
      if (comma >= 0) {
        return [{ start: comma + 1, end: comma + 1, text: (ml ? '\n' + indent : ' ') + text + ',' }];
      }
      return [{ start: item.end, end: item.end, text: ',' + (ml ? '\n' + indent : ' ') + text }];
    },

    removeItem: function (src, ds, arrPath, index) {
      var arr = resolve(ds, arrPath).node;
      if (!arr || arr.t !== 'arr' || !arr.items[index]) throw new Error('削除する1件が見つかりません');
      var item = arr.items[index];
      var start = item.start, end = item.end;
      if (arr.commas[index] >= 0) end = arr.commas[index] + 1;
      else if (index > 0 && arr.commas[index - 1] >= 0) start = arr.commas[index - 1];
      var r = H.util.tidyRange(src, start, end);
      return [{ start: r.start, end: r.end, text: '' }];
    }
  };

  // まとまりに項目を足す。最後の項目の後ろに、同じ書き方で入れる
  function addKeyPatch(src, obj, key, literal) {
    var keyText = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    if (!obj.props.length) return { start: obj.start + 1, end: obj.start + 1, text: ' ' + keyText + ': ' + literal + ' ' };
    var last = obj.props[obj.props.length - 1];
    var ml = multiline(src, obj) && H.util.startsLine(src, last.keyStart);
    if (last.comma >= 0) {
      if (ml) return { start: last.comma + 1, end: last.comma + 1, text: '\n' + H.util.indentAt(src, last.keyStart) + keyText + ': ' + literal + ',' };
      return { start: last.comma + 1, end: last.comma + 1, text: ' ' + keyText + ': ' + literal + ',' };
    }
    if (ml) return { start: last.value.end, end: last.value.end, text: ',\n' + H.util.indentAt(src, last.keyStart) + keyText + ': ' + literal };
    return { start: last.value.end, end: last.value.end, text: ', ' + keyText + ': ' + literal };
  }

  // 手本の1件を、書き方はそのままに値だけ空にした文字列にする
  function blankCopy(src, item, arr) {
    var patches = [];
    function walk(node, key, isTop) {
      if (node.t === 'obj') { node.props.forEach(function (p) { walk(p.value, p.key, isTop); }); return; }
      if (node.t === 'arr') { if (node !== item) patches.push({ start: node.start - item.start, end: node.end - item.start, text: '[]' }); return; }
      var t;
      if (node.t === 'str') t = quoteString('', node.q);
      else if (node.t === 'num') t = isTop && sequential(arr, key) ? String(maxOf(arr, key) + 1) : 'null';
      else if (node.t === 'bool') t = 'false';
      else t = 'null';
      patches.push({ start: node.start - item.start, end: node.end - item.start, text: t });
    }
    if (item.t === 'obj') item.props.forEach(function (p) { walk(p.value, p.key, true); });
    else walk(item, null, false);
    return H.applyPatches(src.slice(item.start, item.end), patches);
  }
  // 「no: 1, 2, 3 …」のような通し番号の列か（項目名が番号らしく、値が重複しない整数）
  function sequential(arr, key) {
    if (!/^(no|id|num|number|idx|index|seq|order|番号)$/i.test(String(key))) return false;
    var vals = arr.items.map(function (it) { var p = prop(it, key); return p && p.value.t === 'num' ? p.value.v : NaN; });
    if (vals.some(function (v) { return !Number.isInteger(v); })) return false;
    return new Set(vals).size === vals.length;
  }
  function maxOf(arr, key) { return Math.max.apply(null, arr.items.map(function (it) { return prop(it, key).value.v; })); }

  // rows 型の一覧で、key の入れ子一覧が空の行に足すときの手本を、ほかの行から探す
  function templateFor(ds, arrPath) {
    if (arrPath.length < 2) return null;
    var key = String(arrPath[arrPath.length - 1]);
    var rows = resolve(ds, arrPath.slice(0, -2)).node;
    if (!rows || rows.t !== 'arr') return null;
    for (var k = 0; k < rows.items.length; k++) {
      var p = prop(rows.items[k], key);
      if (p && p.value.t === 'arr' && p.value.items.length) return { node: p.value.items[0], arr: p.value };
    }
    return null;
  }

  var api = {
    templateFor: templateFor,
    findDatasets: findDatasets, resolve: resolve, columnsOf: columnsOf, stringsOf: stringsOf,
    plain: plain, prop: prop, displayText: displayText, edits: edits, literalFor: literalFor
  };
  root.HedData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
