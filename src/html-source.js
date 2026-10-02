/*
 * html-source.js
 * 元の HTML 文字列を読み取り、各要素が「元の文字列のどこにあるか」を記録する。
 * 編集はすべて「元の文字列の一部を書き換えるパッチ」として表し、変えた箇所以外は1文字も変えない。
 */
(function (root) {
  'use strict';

  var VOID = toSet('area base br col embed hr img input link meta param source track wbr');
  var RAW_TEXT = toSet('script style textarea title xmp iframe noembed noframes noscript template');
  var NO_INSTRUMENT = toSet('html head body script style meta link title base template noscript');
  var P_CLOSERS = toSet('address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul');
  var CLOSE_ON = {
    li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'],
    tr: ['td', 'th', 'tr'], td: ['td', 'th'], th: ['td', 'th'],
    thead: ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot'], tbody: ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot'], tfoot: ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot']
  };

  function toSet(s) { var o = {}; s.split(' ').forEach(function (k) { o[k] = true; }); return o; }
  function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'; }

  // ---------------------------------------------------------------------------
  // 読み取り
  // ---------------------------------------------------------------------------
  function parse(src) {
    var elements = [];
    var stack = [];
    var i = 0, n = src.length;

    function top() { return stack.length ? elements[stack[stack.length - 1]] : null; }
    function closeTop(pos) {
      var el = elements[stack.pop()];
      el.contentEnd = pos; el.end = pos; el.implicitEnd = true;
    }

    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) break;
      i = lt;
      if (src.startsWith('<!--', i)) {
        var ce = src.indexOf('-->', i + 4);
        i = ce < 0 ? n : ce + 3;
        continue;
      }
      if (src[i + 1] === '!' || src[i + 1] === '?') {
        var ge = src.indexOf('>', i);
        i = ge < 0 ? n : ge + 1;
        continue;
      }
      if (src[i + 1] === '/') {
        var m = /^<\/([A-Za-z][^\s/>]*)[^>]*>?/.exec(src.slice(i, i + 200));
        if (!m) { i++; continue; }
        var name = m[1].toLowerCase();
        var endTagEnd = src.indexOf('>', i);
        endTagEnd = endTagEnd < 0 ? n : endTagEnd + 1;
        var k = stack.length - 1;
        while (k >= 0 && elements[stack[k]].tag !== name) k--;
        if (k >= 0) {
          while (stack.length - 1 > k) closeTop(i);
          var el = elements[stack.pop()];
          el.contentEnd = i; el.end = endTagEnd;
        }
        i = endTagEnd;
        continue;
      }
      if (!/[A-Za-z]/.test(src[i + 1] || '')) { i++; continue; }

      // 開始タグ
      var j = i + 1;
      while (j < n && !isWs(src[j]) && src[j] !== '>' && src[j] !== '/') j++;
      var tag = src.slice(i + 1, j).toLowerCase();
      var tagNameEnd = j;
      var attrs = [];
      var selfClosing = false;
      while (j < n) {
        while (j < n && isWs(src[j])) j++;
        if (src[j] === '>') { j++; break; }
        if (src[j] === '/' && src[j + 1] === '>') { selfClosing = true; j += 2; break; }
        if (src[j] === '/') { j++; continue; }
        var as = j;
        while (j < n && !isWs(src[j]) && src[j] !== '=' && src[j] !== '>' && !(src[j] === '/' && src[j + 1] === '>')) j++;
        var attr = { name: src.slice(as, j).toLowerCase(), start: as, end: j, value: '', valueStart: j, valueEnd: j, quote: '' };
        var save = j;
        while (j < n && isWs(src[j])) j++;
        if (src[j] === '=') {
          j++;
          while (j < n && isWs(src[j])) j++;
          if (src[j] === '"' || src[j] === "'") {
            var q = src[j];
            var qe = src.indexOf(q, j + 1);
            if (qe < 0) qe = n - 1;
            attr.quote = q; attr.valueStart = j + 1; attr.valueEnd = qe; j = qe + 1;
          } else {
            attr.valueStart = j;
            while (j < n && !isWs(src[j]) && src[j] !== '>') j++;
            attr.valueEnd = j;
          }
          attr.value = src.slice(attr.valueStart, attr.valueEnd);
          attr.end = j;
        } else {
          j = save;
        }
        attrs.push(attr);
      }
      var startTagEnd = j;

      // 暗黙に閉じられる要素
      var closers = CLOSE_ON[tag];
      if (closers) { while (top() && closers.indexOf(top().tag) >= 0) closeTop(i); }
      if (P_CLOSERS[tag] && top() && top().tag === 'p') closeTop(i);

      var parent = stack.length ? stack[stack.length - 1] : -1;
      var element = {
        id: elements.length, tag: tag, parent: parent, children: [],
        start: i, tagNameEnd: tagNameEnd, startTagEnd: startTagEnd,
        contentStart: startTagEnd, contentEnd: startTagEnd, end: startTagEnd,
        attrs: attrs, implicitEnd: false, instrument: false
      };
      elements.push(element);
      if (parent >= 0) elements[parent].children.push(element.id);

      if (RAW_TEXT[tag] && !selfClosing) {
        var re = new RegExp('</' + tag + '[\\s>/]', 'ig');
        re.lastIndex = startTagEnd;
        var rm = re.exec(src);
        var closeAt = rm ? rm.index : n;
        var closeEnd = rm ? src.indexOf('>', closeAt) + 1 : n;
        element.contentEnd = closeAt; element.end = closeEnd;
        i = closeEnd;
      } else if (VOID[tag] || selfClosing) {
        i = startTagEnd;
      } else {
        stack.push(element.id);
        i = startTagEnd;
      }
    }
    while (stack.length) closeTop(n);

    // どの要素に目印を付けるか（body の中の、表示される要素だけ）
    elements.forEach(function (el) {
      if (NO_INSTRUMENT[el.tag]) return;
      var p = el.parent;
      while (p >= 0) {
        var t = elements[p].tag;
        if (t === 'head' || t === 'template' || t === 'noscript') return;
        p = elements[p].parent;
      }
      el.instrument = true;
    });

    return { src: src, elements: elements };
  }

  // ---------------------------------------------------------------------------
  // 表示用の文字列（目印付き）を作る。元の文字列は変えない
  // ---------------------------------------------------------------------------
  function instrument(doc, headInject) {
    var src = doc.src;
    var inserts = [];
    doc.elements.forEach(function (el) {
      if (el.instrument) inserts.push({ start: el.tagNameEnd, end: el.tagNameEnd, text: ' data-hed-id="' + el.id + '"' });
    });
    if (headInject) {
      var head = doc.elements.filter(function (e) { return e.tag === 'head'; })[0];
      var at = head ? head.startTagEnd : 0;
      if (!head) { var dt = /^\s*<!doctype[^>]*>/i.exec(src); if (dt) at = dt[0].length; }
      inserts.push({ start: at, end: at, text: headInject });
    }
    return applyPatches(src, inserts);
  }

  function instrumentedIds(doc) {
    return doc.elements.filter(function (e) { return e.instrument; }).map(function (e) { return e.id; });
  }

  // ---------------------------------------------------------------------------
  // パッチ
  // ---------------------------------------------------------------------------
  function applyPatches(src, patches) {
    var list = patches.slice().sort(function (a, b) { return b.start - a.start || b.end - a.end; });
    var out = src;
    var lastStart = Infinity;
    list.forEach(function (p) {
      if (p.end > lastStart) throw new Error('重なったパッチがあります');
      out = out.slice(0, p.start) + p.text + out.slice(p.end);
      lastStart = p.start;
    });
    return out;
  }

  function lineStart(src, pos) { var k = pos; while (k > 0 && src[k - 1] !== '\n') k--; return k; }
  function lineEnd(src, pos) { var k = pos; while (k < src.length && src[k] !== '\n') k++; return k; }
  function onlyWs(s) { return /^[ \t\r]*$/.test(s); }
  function indentAt(src, pos) { var ls = lineStart(src, pos); return /^[ \t]*/.exec(src.slice(ls, pos))[0]; }
  function startsLine(src, pos) { return onlyWs(src.slice(lineStart(src, pos), pos)); }

  // 削除範囲を、行まるごとになるなら行ごと消す（空行を残さない）
  function tidyRange(src, start, end) {
    var ls = lineStart(src, start), le = lineEnd(src, end);
    if (onlyWs(src.slice(ls, start)) && onlyWs(src.slice(end, le))) {
      return { start: ls, end: le < src.length ? le + 1 : le };
    }
    return { start: start, end: end };
  }

  // 要素のすぐ後ろに HTML を差し込む。要素が行頭にあれば次の行に同じ字下げで入れる
  function insertAfterPatch(src, el, html) {
    if (startsLine(src, el.start) && onlyWs(src.slice(el.end, lineEnd(src, el.end)))) {
      return { start: el.end, end: el.end, text: '\n' + indentAt(src, el.start) + html };
    }
    return { start: el.end, end: el.end, text: html };
  }

  function getAttr(el, name) {
    for (var k = 0; k < el.attrs.length; k++) if (el.attrs[k].name === name) return el.attrs[k];
    return null;
  }

  function escapeAttr(v, q) {
    v = v.replace(/&/g, '&amp;');
    return q === "'" ? v.replace(/'/g, '&#39;') : v.replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // 編集操作（パッチの配列を返す）
  // ---------------------------------------------------------------------------
  var ops = {
    setContent: function (doc, id, html) {
      var el = doc.elements[id];
      return [{ start: el.contentStart, end: el.contentEnd, text: html }];
    },

    // style 属性の1項目だけを書き換える。value が null ならその項目を外す
    setStyle: function (doc, id, prop, value) {
      var el = doc.elements[id];
      var attr = getAttr(el, 'style');
      var decls = [];
      if (attr) {
        attr.value.split(';').forEach(function (d) {
          var c = d.indexOf(':');
          if (c < 0) return;
          var k = d.slice(0, c).trim(), v = d.slice(c + 1).trim();
          if (k) decls.push([k, v]);
        });
      }
      var found = false;
      decls = decls.filter(function (d) {
        if (d[0].toLowerCase() !== prop) return true;
        if (value === null) return false;
        if (!found) { d[1] = value; found = true; return true; }
        return false;
      });
      if (!found && value !== null) decls.push([prop, value]);
      var css = decls.map(function (d) { return d[0] + ': ' + d[1]; }).join('; ');
      if (attr) {
        if (!css) return [tidyAttrRemoval(doc.src, attr)];
        var q = attr.quote || '"';
        return [{ start: attr.start, end: attr.end, text: 'style=' + q + escapeAttr(css, q) + q }];
      }
      if (!css) return [];
      var at = el.attrs.length ? el.attrs[el.attrs.length - 1].end : el.tagNameEnd;
      return [{ start: at, end: at, text: ' style="' + escapeAttr(css, '"') + '"' }];
    },

    remove: function (doc, id) {
      var el = doc.elements[id];
      var r = tidyRange(doc.src, el.start, el.end);
      return [{ start: r.start, end: r.end, text: '' }];
    },

    insertAfter: function (doc, id, html) {
      return [insertAfterPatch(doc.src, doc.elements[id], html)];
    },

    rowAdd: function (doc, trId) {
      var tr = doc.elements[trId];
      var inner = [];
      cellsOf(doc, trId).forEach(function (cid) {
        var c = doc.elements[cid];
        inner.push({ start: c.contentStart - tr.start, end: c.contentEnd - tr.start, text: '' });
      });
      var html = applyPatches(doc.src.slice(tr.start, tr.end), inner);
      if (tr.implicitEnd) html += '</tr>';
      return [insertAfterPatch(doc.src, tr, html)];
    },

    rowRemove: function (doc, trId) { return ops.remove(doc, trId); },

    colAdd: function (doc, cellId) {
      var idx = cellIndex(doc, cellId);
      var table = tableOf(doc, cellId);
      var patches = [];
      rowsOf(doc, table).forEach(function (trId) {
        var cid = cellsOf(doc, trId)[idx];
        if (cid === undefined) return;
        var c = doc.elements[cid];
        var html = doc.src.slice(c.start, c.startTagEnd) + (c.implicitEnd ? '</' + c.tag + '>' : doc.src.slice(c.contentEnd, c.end));
        patches.push(insertAfterPatch(doc.src, c, html));
      });
      return patches;
    },

    colRemove: function (doc, cellId) {
      var idx = cellIndex(doc, cellId);
      var table = tableOf(doc, cellId);
      var patches = [];
      rowsOf(doc, table).forEach(function (trId) {
        var cid = cellsOf(doc, trId)[idx];
        if (cid === undefined) return;
        var c = doc.elements[cid];
        var r = tidyRange(doc.src, c.start, c.end);
        patches.push({ start: r.start, end: r.end, text: '' });
      });
      return patches;
    }
  };

  function tidyAttrRemoval(src, attr) {
    var s = attr.start;
    while (s > 0 && isWs(src[s - 1])) s--;
    return { start: s, end: attr.end, text: '' };
  }

  // ---------------------------------------------------------------------------
  // 表のための補助
  // ---------------------------------------------------------------------------
  function closestTag(doc, id, tags) {
    var p = id;
    while (p >= 0) { if (tags.indexOf(doc.elements[p].tag) >= 0) return p; p = doc.elements[p].parent; }
    return -1;
  }
  function tableOf(doc, id) { return closestTag(doc, id, ['table']); }
  function rowsOf(doc, tableId) {
    var out = [];
    (function walk(id) {
      doc.elements[id].children.forEach(function (c) {
        var t = doc.elements[c].tag;
        if (t === 'tr') out.push(c);
        else if (t === 'thead' || t === 'tbody' || t === 'tfoot') walk(c);
      });
    })(tableId);
    return out;
  }
  function cellsOf(doc, trId) {
    return doc.elements[trId].children.filter(function (c) { var t = doc.elements[c].tag; return t === 'td' || t === 'th'; });
  }
  function cellIndex(doc, cellId) {
    var cell = closestTag(doc, cellId, ['td', 'th']);
    return cellsOf(doc, doc.elements[cell].parent).indexOf(cell);
  }
  function hasMergedCells(doc, tableId) {
    var merged = false;
    rowsOf(doc, tableId).forEach(function (trId) {
      cellsOf(doc, trId).forEach(function (cid) {
        ['colspan', 'rowspan'].forEach(function (a) {
          var at = getAttr(doc.elements[cid], a);
          if (at && parseInt(at.value, 10) > 1) merged = true;
        });
      });
    });
    return merged;
  }

  var api = {
    parse: parse, instrument: instrument, instrumentedIds: instrumentedIds,
    applyPatches: applyPatches, ops: ops, getAttr: getAttr,
    table: { closestTag: closestTag, tableOf: tableOf, rowsOf: rowsOf, cellsOf: cellsOf, cellIndex: cellIndex, hasMergedCells: hasMergedCells },
    util: { lineStart: lineStart, lineEnd: lineEnd, indentAt: indentAt, startsLine: startsLine, tidyRange: tidyRange }
  };
  root.HedHtml = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
