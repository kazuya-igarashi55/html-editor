/*
 * app.js — HTMLエディタの画面と操作
 * 正（しょう）は常に state.src（元のHTML文字列）。編集はすべて state.src へのパッチとして行い、
 * 表示は state.src に目印を付けたものを iframe に読み込んで作る。保存するのは state.src だけ。
 */
(function () {
  'use strict';
  var H = window.HedHtml, D = window.HedData;
  var $ = function (id) { return document.getElementById(id); };

  var ERROR_HOOK = '<script>window.__hedErrors=[];window.addEventListener("error",function(e){window.__hedErrors.push(String(e.message||e));});</script>';
  var FRAME_CSS = [
    'html[data-hed-mode="edit"] body *{cursor:pointer!important}',
    'html[data-hed-mode="edit"] [contenteditable="true"],html[data-hed-mode="edit"] [contenteditable="true"] *{cursor:text!important}',
    '[contenteditable="true"]{outline:2px solid #0f8a5f!important;outline-offset:2px;background:rgba(15,138,95,.07)!important}',
    'html[data-hed-mode="edit"]{scroll-behavior:auto!important}'
  ].join('\n');
  var TAG_LABEL = { h1: '大見出し', h2: '見出し', h3: '小見出し', h4: '小見出し', h5: '小見出し', h6: '小見出し', p: '段落', li: '箇条書きの1行', ul: '箇条書き', ol: '番号付き箇条書き', td: '表のセル', th: '表の見出しセル', tr: '表の1行', table: '表', thead: '表の見出し部分', tbody: '表の本体', span: '文字のまとまり', b: '太字', strong: '太字', i: '文字飾り', em: '強調', a: 'リンク', div: 'ブロック', section: 'セクション', header: 'ヘッダー', footer: 'フッター', main: '本文', article: '記事ブロック', nav: 'ナビ', time: '日付', img: '画像', small: '小さい文字', label: 'ラベル', button: 'ボタン', blockquote: '引用', dl: '説明リスト', dt: '用語', dd: '説明', figure: '図', figcaption: '図の説明', aside: '補足' };
  var BASIC_TEXT = ['#1f2430', '#2f6fed', '#d9363e', '#0f8a5f', '#b45309', '#6b7280'];
  var BASIC_BG = ['#ffffff', '#e8f0fe', '#fff1f2', '#e3f6ee', '#fef3c7', '#f3f4f6'];
  var NO_TEXT_EDIT = { table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, ul: 1, ol: 1, dl: 1, select: 1, img: 1, br: 1, hr: 1, input: 1, svg: 1, iframe: 1, video: 1, audio: 1, canvas: 1 };

  var state = {
    name: '', handle: null, original: '', src: '', savedSrc: '',
    doc: null, datasets: [], undo: [], history: [], backupName: '',
    frame: null, frameOk: false, baseErrors: 0,
    mode: 'edit', view: 'doc', sel: null, hoverEl: null, editing: null,
    palette: { text: [], bg: [] }, highlight: null, renderSeq: 0
  };

  // ===========================================================================
  // ファイルを開く
  // ===========================================================================
  function openPicker() {
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker({ types: [{ description: 'HTML ファイル', accept: { 'text/html': ['.html', '.htm'] } }] })
        .then(function (hs) { return hs[0].getFile().then(function (f) { return f.text().then(function (t) { confirmDiscard() && loadDocument(t, f.name, hs[0]); }); }); })
        .catch(function (e) { if (e && e.name !== 'AbortError') toast('ファイルを開けませんでした: ' + e.message, true); });
    } else {
      $('fileInput').click();
    }
  }
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    f.text().then(function (t) { if (confirmDiscard()) loadDocument(t, f.name, null); });
    e.target.value = '';
  });
  function confirmDiscard() {
    return !isDirty() || window.confirm('保存していない変更があります。破棄して別のファイルを開きますか？');
  }

  // 画面のどこにドロップしても開ける
  var dz = $('dropzone');
  window.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); dz.hidden = false; });
  window.addEventListener('dragleave', function (e) { if (!e.relatedTarget) { dz.classList.remove('over'); dz.hidden = !!state.src; } });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dz.classList.remove('over'); dz.hidden = !!state.src;
    var item = e.dataTransfer.items && e.dataTransfer.items[0];
    var file = e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.html?$/i.test(file.name)) { toast('HTML ファイル（.html）を選んでください', true); return; }
    var getHandle = item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : Promise.resolve(null);
    getHandle.then(function (h) {
      file.text().then(function (t) { if (confirmDiscard()) loadDocument(t, file.name, h && h.kind === 'file' ? h : null); });
    });
  });

  function loadDocument(text, name, handle) {
    state.name = name; state.handle = handle;
    state.original = text; state.src = text; state.savedSrc = text;
    state.undo = []; state.history = []; state.backupName = '';
    state.sel = null; state.editing = null; state.highlight = null;
    state.baseErrors = -1;
    $('dropzone').hidden = true;
    $('viewSeg').hidden = false; $('modeSeg').hidden = false;
    setView('doc'); setMode('edit');
    render({ initial: true }).then(function () {
      renderDataView(); renderPanel(); renderHistory(); updateChrome();
      var n = state.datasets.length;
      toast(n ? '読み込みました。データの一覧が ' + n + ' 個見つかりました（上の「データ」タブ）' : '読み込みました');
    });
  }
  window.HedApp = { loadDocument: loadDocument, state: state }; // 動作確認用

  // ===========================================================================
  // 表示（iframe）
  // ===========================================================================
  function parseAll() {
    state.doc = H.parse(state.src);
    state.datasets = D.findDatasets(state.doc);
  }

  function render(opts) {
    opts = opts || {};
    parseAll();
    var seq = ++state.renderSeq;
    var old = state.frame;
    var scrollY = opts.initial ? 0 : (opts.scrollY !== undefined ? opts.scrollY : frameScrollY());
    var frame = document.createElement('iframe');
    frame.className = 'loading';
    frame.setAttribute('title', '編集中の資料');
    $('frames').appendChild(frame);
    return new Promise(function (resolve) {
      frame.addEventListener('load', function () {
        if (seq !== state.renderSeq) { frame.remove(); resolve(); return; }
        setupFrame(frame);
        try {
          frame.contentWindow.scrollTo(0, scrollY);
        } catch (e) { /* noop */ }
        // 少し待ってから入れ替える（描画のちらつきを抑える）
        setTimeout(function () {
          frame.classList.remove('loading');
          if (old) old.remove();
          state.frame = frame;
          checkErrors(frame, opts.initial);
          collectPalette();
          if (opts.selectId !== undefined && opts.selectId !== null) {
            var el = frame.contentDocument.querySelector('[data-hed-id="' + opts.selectId + '"]');
            if (el) state.sel = { type: 'static', el: el }; else state.sel = null;
          } else if (state.sel && state.sel.type === 'row') {
            state.sel.el = findRowElement(state.sel.ds, state.sel.index);
          } else if (state.sel && state.sel.type !== 'row') {
            state.sel = null;
          }
          state.hoverEl = null;
          updateOverlay(); renderPanel();
          resolve();
        }, 30);
      }, { once: true });
      frame.srcdoc = H.instrument(state.doc, ERROR_HOOK);
    });
  }

  function frameDoc() { return state.frame ? state.frame.contentDocument : null; }
  function frameScrollY() { try { return state.frame ? state.frame.contentWindow.scrollY : 0; } catch (e) { return 0; } }

  function checkErrors(frame, initial) {
    var errs = (frame.contentWindow.__hedErrors || []).length;
    if (initial || state.baseErrors < 0) { state.baseErrors = errs; return; }
    if (errs > state.baseErrors) {
      toast('変更後、資料のプログラムでエラーが出ました。表示が崩れていたら「1つ戻す」で戻せます', true);
    }
  }

  function setupFrame(frame) {
    var w = frame.contentWindow, d = frame.contentDocument;
    var st = d.createElement('style'); st.textContent = FRAME_CSS;
    (d.head || d.documentElement).appendChild(st);
    d.documentElement.setAttribute('data-hed-mode', state.mode);
    w.addEventListener('mouseover', onFrameHover, true);
    w.addEventListener('mouseleave', function () { state.hoverEl = null; updateOverlay(); });
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function (t) { w.addEventListener(t, onFramePointer, true); });
    w.addEventListener('click', onFrameClick, true);
    w.addEventListener('dblclick', onFrameDblClick, true);
    w.addEventListener('submit', function (e) { e.preventDefault(); toast('フォームの送信はしません'); }, true);
    w.addEventListener('keydown', onKey, true);
    w.addEventListener('paste', onFramePaste, true);
    w.addEventListener('scroll', updateOverlay, { passive: true });
    w.addEventListener('resize', updateOverlay);
  }

  // 元の文字列とiframeの要素が1対1で並んでいるか確かめ、目印の番号を付け直す
  function resync() {
    var d = frameDoc(); if (!d) return false;
    var ids = H.instrumentedIds(state.doc);
    var els = d.querySelectorAll('[data-hed-id],[data-hed-new]');
    if (els.length !== ids.length) return false;
    for (var k = 0; k < els.length; k++) {
      if (els[k].tagName.toLowerCase() !== state.doc.elements[ids[k]].tag) return false;
    }
    for (var j = 0; j < els.length; j++) { els[j].setAttribute('data-hed-id', ids[j]); els[j].removeAttribute('data-hed-new'); }
    return true;
  }

  // ===========================================================================
  // 変更の確定（元に戻すための記録・履歴）
  // ===========================================================================
  function stamp() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function pad(n) { return ('0' + n).slice(-2); }

  function pushUndo(before, kind, kindLabel, summary) {
    state.undo.push({ src: before });
    state.history.unshift({ t: stamp(), kind: kind, k: kindLabel, s: summary });
  }

  // 静的な部分（HTMLに直接書かれた部分）の変更：iframe は作り直さずに同じ変更を当てる
  function commitStatic(kind, kindLabel, summary, patches, domChange, opts) {
    opts = opts || {};
    var before = state.src;
    var next = H.applyPatches(before, patches);
    if (next === before) return false;
    if (opts.mergeIntoLast && state.undo.length) {
      state.history[0] = { t: stamp(), kind: kind, k: kindLabel, s: summary };
    } else {
      pushUndo(before, kind, kindLabel, summary);
    }
    state.src = next;
    parseAll();
    if (domChange) domChange();
    var selId = state.sel && state.sel.el ? state.sel.el.getAttribute('data-hed-id') : null;
    if (!resync()) {
      // 資料のプログラムが要素を動かしている等で対応が崩れたら、作り直して確実に合わせる
      render({ selectId: opts.selectAfter !== undefined ? opts.selectAfter : selId }).then(afterChange);
      return true;
    }
    afterChange();
    return true;
  }

  // データの変更：資料のプログラムに描き直してもらうため、iframe を作り直す
  function commitData(summary, patches, opts) {
    opts = opts || {};
    var before = state.src;
    var next = H.applyPatches(before, patches);
    if (next === before) return Promise.resolve(false);
    pushUndo(before, 'data', 'データ', summary);
    state.src = next;
    return render({}).then(function () {
      if (opts.structural) renderDataView();
      renderPanel();
      afterChange();
      return true;
    });
  }

  function afterChange() { renderHistory(); updateChrome(); updateOverlay(); if (state.view === 'data') refreshDataCounts(); }

  function undo() {
    if (state.editing) finishEdit(true);
    var u = state.undo.pop(); if (!u) return;
    var h = state.history.shift();
    var selId = state.sel && state.sel.type === 'static' && state.sel.el ? state.sel.el.getAttribute('data-hed-id') : null;
    state.src = u.src;
    render({ selectId: selId }).then(function () {
      renderDataView(); renderPanel(); renderHistory(); updateChrome();
      if (h) toast('取り消しました: ' + h.k + ' ' + h.s);
    });
  }

  function isDirty() { return state.src && state.src !== state.savedSrc; }

  // ===========================================================================
  // モード・表示切替
  // ===========================================================================
  function setMode(m) {
    if (state.editing) finishEdit(false);
    state.mode = m;
    Array.prototype.forEach.call($('modeSeg').children, function (b) { b.classList.toggle('on', b.dataset.mode === m); });
    var d = frameDoc(); if (d) d.documentElement.setAttribute('data-hed-mode', m);
    state.hoverEl = null;
    $('statusMode').innerHTML = m === 'operate' ? '<span class="mode-op">操作モード中：資料をふだんどおり操作できます（タブ切替・開閉など）。編集するときは「✎ 編集」に戻してください</span>' : '編集モード：クリックで選択、ダブルクリックで文言を編集';
    updateOverlay();
  }
  function setView(v) {
    if (state.editing) finishEdit(false);
    state.view = v;
    Array.prototype.forEach.call($('viewSeg').children, function (b) { b.classList.toggle('on', b.dataset.view === v); });
    $('dataview').hidden = v !== 'data';
    $('modeSeg').style.visibility = v === 'data' ? 'hidden' : '';
    if (v === 'data') renderDataView();
    updateOverlay();
  }
  $('modeSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  $('viewSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setView(b.dataset.view); });

  // ===========================================================================
  // iframe 内の操作
  // ===========================================================================
  function isEditMode() { return state.mode === 'edit' && state.view === 'doc'; }

  function onFrameHover(e) {
    if (!isEditMode() || state.editing) return;
    var t = e.target;
    if (!t || t.nodeType !== 1 || t === t.ownerDocument.body || t === t.ownerDocument.documentElement) t = null;
    state.hoverEl = t;
    updateOverlay();
  }

  function onFramePointer(e) {
    if (!isEditMode()) return;
    if (state.editing && state.editing.el.contains(e.target)) { e.stopPropagation(); return; }
    e.stopImmediatePropagation();
    if (e.type === 'mousedown') e.preventDefault();
  }

  function onFrameClick(e) {
    if (state.mode === 'operate' || state.view !== 'doc') { blockNavigation(e); return; }
    if (state.editing) {
      if (state.editing.el.contains(e.target)) { e.stopImmediatePropagation(); if (e.target.closest('a')) e.preventDefault(); return; }
      finishEdit(false);
    }
    e.preventDefault(); e.stopImmediatePropagation();
    pick(e.target);
  }

  function onFrameDblClick(e) {
    if (!isEditMode()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (state.editing) return;
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-hed-id')) {
      state.sel = { type: 'static', el: t };
      tryStartEdit(t);
    } else {
      pick(t);
    }
  }

  // 操作モードでも、別のページへ移動するリンクは止める（ページ内の移動は通す）
  function blockNavigation(e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') {
      e.preventDefault();
      var target = a.ownerDocument.getElementById(decodeURIComponent(href.slice(1)));
      if (target) target.scrollIntoView({ block: 'start' });
      return;
    }
    e.preventDefault();
    toast('エディタの中ではリンク先へ移動しません');
  }

  function onFramePaste(e) {
    if (!state.editing) return;
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    state.editing.el.ownerDocument.execCommand('insertText', false, text);
  }

  // クリックされた場所が「HTMLに直接書かれた部分」か「プログラムが作った部分」かで分ける
  function pick(t) {
    if (!t || t.nodeType !== 1) return;
    var d = t.ownerDocument;
    if (t === d.body || t === d.documentElement) { select(null); return; }
    if (t.hasAttribute('data-hed-id')) { select({ type: 'static', el: t }); return; }
    var found = findRow(t);
    if (found.unique) {
      select({ type: 'row', ds: found.ds, index: found.index, el: found.el });
    } else if (found.candidates.length) {
      state.highlight = { ds: found.candidates[0].ds, indexes: found.candidates.map(function (c) { return c.index; }) };
      select(null);
      setView('data');
      toast('どの1件か特定できなかったため、候補の行を黄色で示しています');
    } else {
      select({ type: 'computed', el: t });
    }
  }

  function select(sel) {
    if (state.editing) finishEdit(false);
    state.sel = sel;
    renderPanel(); updateOverlay();
  }

  // ---------------------------------------------------------------------------
  // プログラムが作った部分 → データの何件目か
  // ---------------------------------------------------------------------------
  function rowDatasets() { return state.datasets.filter(function (d) { return d.kind === 'rows'; }); }
  function dsByName(name) { return state.datasets.filter(function (d) { return d.name === name; })[0] || null; }

  function findRow(t) {
    // ① 目印（data-source / data-index）があればそれで決める
    var mk = t.closest('[data-source][data-index]');
    if (mk) {
      var ds = dsByName(mk.getAttribute('data-source'));
      var idx = parseInt(mk.getAttribute('data-index'), 10);
      if (ds && ds.kind === 'rows' && ds.node.items[idx]) return { unique: true, ds: ds.name, index: idx, el: mk, candidates: [] };
    }
    // ② 目印が無ければ、表示されている文字とデータの値を照らし合わせて推測する
    var rows = [];
    rowDatasets().forEach(function (ds) {
      ds.node.items.forEach(function (it, i) { rows.push({ ds: ds.name, index: i, strs: D.stringsOf(it) }); });
    });
    function judge(a) {
      var text = a.textContent || '';
      var best = 0, second = 0, bestRow = null, scored = [];
      rows.forEach(function (r) {
        var sc = 0;
        r.strs.forEach(function (s) { if (text.indexOf(s) >= 0) sc++; });
        if (sc > 0) scored.push({ r: r, sc: sc });
        if (sc > best) { second = best; best = sc; bestRow = r; } else if (sc > second) second = sc;
      });
      return { unique: best > 0 && best > second, row: bestRow, best: best, scored: scored };
    }
    function generated(a) { return a && a.nodeType === 1 && !a.hasAttribute('data-hed-id') && a !== a.ownerDocument.body; }
    var a = t, lastCands = [];
    while (generated(a)) {
      var j = judge(a);
      if (j.unique) {
        // 同じ1件に決まる範囲で、一番外側のまとまり（カードなど）まで枠を広げる
        var el = a;
        while (generated(el.parentElement)) {
          var jp = judge(el.parentElement);
          if (!jp.unique || jp.row !== j.row) break;
          el = el.parentElement;
        }
        return { unique: true, ds: j.row.ds, index: j.row.index, el: el, candidates: [] };
      }
      if (j.best > 0) lastCands = j.scored.filter(function (x) { return x.sc === j.best; }).map(function (x) { return x.r; });
      a = a.parentElement;
    }
    return { unique: false, candidates: lastCands };
  }

  // 描き直した後に、選んでいた1件の要素を探し直す（目印がある資料だけ）
  function findRowElement(ds, index) {
    var d = frameDoc(); if (!d) return null;
    return d.querySelector('[data-source="' + ds + '"][data-index="' + index + '"]');
  }

  // ===========================================================================
  // 選択枠・操作バー
  // ===========================================================================
  function place(box, el, show) {
    if (!show || !el || !el.isConnected) { box.style.display = 'none'; return null; }
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) { box.style.display = 'none'; return null; }
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    return r;
  }
  function staticParent(el) {
    var p = el.parentElement;
    while (p && !p.hasAttribute('data-hed-id')) p = p.parentElement;
    if (!p || p === p.ownerDocument.body) return null;
    return p;
  }

  function updateOverlay() {
    var on = isEditMode() && !!state.frame;
    var hv = state.hoverEl && state.hoverEl.isConnected ? state.hoverEl : null;
    var sel = state.sel && state.sel.el && state.sel.el.isConnected ? state.sel.el : null;
    place($('boxHover'), hv, on && hv && hv !== sel && !state.editing);
    var par = hv ? (hv.hasAttribute('data-hed-id') ? staticParent(hv) : hv.parentElement) : null;
    place($('boxParent'), par, on && par && !state.editing);
    var bs = $('boxSelected');
    bs.className = 'box selected' + (state.sel ? ' ' + state.sel.type : '');
    var r = place(bs, sel, on && sel && !state.editing);
    var fb = $('floatbar');
    if (!r || !state.sel || state.sel.type === 'computed') { fb.style.display = 'none'; return; }
    renderFloatbar();
    fb.style.display = 'flex';
    var ov = $('overlay').getBoundingClientRect();
    var top = r.top - fb.offsetHeight - 8;
    if (top < 4) top = r.bottom + 8;
    if (top > ov.height - fb.offsetHeight - 4) top = Math.max(4, r.top + 4);
    var left = Math.min(Math.max(4, r.left), Math.max(4, ov.width - fb.offsetWidth - 4));
    fb.style.top = top + 'px'; fb.style.left = left + 'px';
  }

  function renderFloatbar() {
    var fb = $('floatbar'), s = state.sel, html = '';
    if (s.type === 'static') {
      var info = staticInfo(s.el);
      html += btn('edit', '✎ 文言を編集', !info.textEdit.ok);
      if (info.cell) {
        html += '<span class="sep"></span>' + tableBtns(info, '') + '<span class="sep"></span>';
      } else {
        html += btn('add', '＋ 下にテキスト追加');
      }
      html += btn('parent', '⬆ ひとつ外側を選択', !staticParent(s.el));
      html += btn('del', '🗑 削除', false, 'del');
    } else if (s.type === 'row') {
      html += '<span class="lbl">データ: ' + esc(s.ds) + ' の ' + (s.index + 1) + '件目（右パネルで編集）</span>';
      html += btn('showData', '一覧で見る');
    }
    fb.innerHTML = html;
  }
  function btn(act, label, disabled, cls, title) {
    return '<button data-act="' + act + '"' + (cls ? ' class="' + cls + '"' : '') + (disabled ? ' disabled' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
  }
  function tableBtns(info, cls) {
    var dis = info.merged;
    var t = dis ? '結合セルがあるため、この表は文言修正のみです' : '';
    return btn('rowAdd', '＋ 下に行', dis, cls, t) + btn('colAdd', '＋ 右に列', dis, cls, t) +
      btn('rowDel', '行を削除', dis, cls ? cls + ' danger' : 'del', t) + btn('colDel', '列を削除', dis, cls ? cls + ' danger' : 'del', t);
  }
  $('floatbar').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('floatbar').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && !b.disabled) act(b.dataset.act); });

  // ===========================================================================
  // 静的な部分の操作
  // ===========================================================================
  function idOf(el) { return parseInt(el.getAttribute('data-hed-id'), 10); }
  function label(el) { return TAG_LABEL[el.tagName.toLowerCase()] || el.tagName.toLowerCase(); }
  function snip(el, n) { var t = (el.textContent || '').trim().replace(/\s+/g, ' '); n = n || 22; return t.length > n ? t.slice(0, n) + '…' : t; }

  function staticInfo(el) {
    var id = idOf(el);
    var cellId = H.table.closestTag(state.doc, id, ['td', 'th']);
    var info = { id: id, textEdit: canEditText(el), cell: cellId >= 0 ? cellId : null, merged: false };
    if (info.cell !== null) {
      var tb = H.table.tableOf(state.doc, cellId);
      info.merged = tb >= 0 && H.table.hasMergedCells(state.doc, tb);
    }
    return info;
  }

  function canEditText(el) {
    var tag = el.tagName.toLowerCase();
    if (NO_TEXT_EDIT[tag] || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return { ok: false, reason: 'この要素には直接書き換える文字がありません。中の文字をダブルクリックしてください' };
    var all = el.querySelectorAll('*');
    for (var k = 0; k < all.length; k++) {
      if (!all[k].hasAttribute('data-hed-id')) return { ok: false, reason: 'この中にはプログラムで作られた部分があるため、文言の直接編集はできません' };
    }
    var hasText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
    if (el.children.length && !hasText) return { ok: false, reason: 'まとまり（中に複数の要素がある部分）は、まとめて文言編集できません。中の文字をダブルクリックしてください' };
    return { ok: true };
  }

  function tryStartEdit(el, fresh) {
    var c = canEditText(el);
    if (!c.ok) { toast(c.reason); select({ type: 'static', el: el }); return; }
    startEdit(el, fresh);
  }

  function cleanInner(el) {
    var c = el.cloneNode(true);
    c.querySelectorAll('[data-hed-id],[data-hed-new],[contenteditable]').forEach(function (n) {
      n.removeAttribute('data-hed-id'); n.removeAttribute('data-hed-new'); n.removeAttribute('contenteditable');
    });
    return c.innerHTML;
  }

  function startEdit(el, fresh) {
    state.sel = { type: 'static', el: el };
    state.editing = { el: el, raw: el.innerHTML, before: cleanInner(el), fresh: !!fresh };
    el.setAttribute('contenteditable', 'true');
    el.focus();
    var d = el.ownerDocument, r = d.createRange();
    r.selectNodeContents(el);
    if (!fresh) r.collapse(false);
    var s = d.getSelection(); s.removeAllRanges(); s.addRange(r);
    renderPanel(); updateOverlay();
  }

  function finishEdit(cancel) {
    var ed = state.editing; if (!ed) return;
    state.editing = null;
    var el = ed.el;
    el.removeAttribute('contenteditable');
    try { el.ownerDocument.getSelection().removeAllRanges(); } catch (e) { /* noop */ }
    var after = cleanInner(el);
    if (cancel || after === ed.before) {
      if (cancel) el.innerHTML = ed.raw;
      if (ed.fresh) { undo(); return; }
      renderPanel(); updateOverlay();
      return;
    }
    var id = idOf(el);
    var summary = label(el) + '「' + snip(el) + '」';
    commitStatic(ed.fresh ? 'add' : 'edit', ed.fresh ? '追加' : '文言', summary, H.ops.setContent(state.doc, id, after), null, { mergeIntoLast: ed.fresh });
    renderPanel();
  }

  function act(name) {
    var s = state.sel;
    if (name === 'showData') { if (s && s.type === 'row') { state.highlight = { ds: s.ds, indexes: [s.index] }; setView('data'); } return; }
    if (!s || s.type !== 'static') return;
    var el = s.el, id = idOf(el);
    if (name === 'edit') return tryStartEdit(el);
    if (name === 'parent') { var p = staticParent(el); if (p) select({ type: 'static', el: p }); else toast('これより外側はありません'); return; }
    if (name === 'del') return deleteStatic(el);
    if (name === 'add') return addBelow(el);
    if (/^(row|col)(Add|Del)$/.test(name)) return tableAct(name, el);
  }

  function deleteStatic(el) {
    var id = idOf(el), summary = label(el) + '「' + snip(el) + '」';
    state.sel = null;
    commitStatic('del', '削除', summary, H.ops.remove(state.doc, id), function () { el.remove(); });
    renderPanel();
    toast('削除しました。「1つ戻す」で元に戻せます');
  }

  function addBelow(el) {
    var base = el;
    while (base && /^inline/.test(base.ownerDocument.defaultView.getComputedStyle(base).display)) base = staticParent(base);
    if (!base) { toast('ここには追加できません'); return; }
    var tag = base.tagName.toLowerCase();
    if (/^(td|th|tr|thead|tbody|table)$/.test(tag)) { toast('表の中では「＋ 下に行」「＋ 右に列」を使ってください'); return; }
    var newTag = (tag === 'li' || tag === 'p' || tag === 'dd') ? tag : 'p';
    var cls = '';
    if (newTag === tag) { var ca = H.getAttr(state.doc.elements[idOf(base)], 'class'); if (ca) cls = ' class="' + ca.value.replace(/"/g, '&quot;') + '"'; }
    var html = '<' + newTag + cls + '>新しいテキスト</' + newTag + '>';
    var created = null;
    var ok = commitStatic('add', '追加', TAG_LABEL[newTag] || newTag, H.ops.insertAfter(state.doc, idOf(base), html), function () {
      base.insertAdjacentHTML('afterend', html);
      created = base.nextElementSibling;
      created.setAttribute('data-hed-new', '1');
    });
    if (ok && created && created.isConnected) startEdit(created, true);
  }

  function tableAct(name, el) {
    var info = staticInfo(el);
    if (info.cell === null) return;
    if (info.merged) { toast('結合セルがあるため、この表は文言修正のみです'); return; }
    var d = frameDoc();
    var cellEl = d.querySelector('[data-hed-id="' + info.cell + '"]');
    var trEl = cellEl.parentElement, tableEl = cellEl.closest('table');
    var trId = state.doc.elements[info.cell].parent;
    var idx = H.table.cellIndex(state.doc, info.cell);
    var rows = H.table.rowsOf(state.doc, H.table.tableOf(state.doc, info.cell));
    var cellCount = H.table.cellsOf(state.doc, trId).length;
    function blank(n) { n.removeAttribute('data-hed-id'); n.setAttribute('data-hed-new', '1'); }
    if (name === 'rowAdd') {
      var nr = null;
      commitStatic('add', '表', '行を追加', H.ops.rowAdd(state.doc, trId), function () {
        nr = trEl.cloneNode(true);
        blank(nr);
        Array.prototype.forEach.call(nr.querySelectorAll('[data-hed-id]'), function (c) { c.removeAttribute('data-hed-id'); });
        Array.prototype.forEach.call(nr.cells, function (c) { c.textContent = ''; blank(c); });
        trEl.insertAdjacentElement('afterend', nr);
      });
      if (nr && nr.cells[idx]) select({ type: 'static', el: nr.cells[idx] });
    } else if (name === 'rowDel') {
      if (rows.length <= 1) { toast('最後の1行は削除できません。表ごと消すときは「ひとつ外側」で表を選んでください'); return; }
      state.sel = null;
      commitStatic('del', '表', '行を削除「' + snip(trEl) + '」', H.ops.rowRemove(state.doc, trId), function () { trEl.remove(); });
    } else if (name === 'colAdd') {
      var mine = null;
      commitStatic('add', '表', '列を追加（' + (idx + 2) + '列目）', H.ops.colAdd(state.doc, info.cell), function () {
        Array.prototype.forEach.call(tableEl.rows, function (r) {
          var c = r.cells[idx]; if (!c) return;
          var nc = c.cloneNode(false); blank(nc);
          c.insertAdjacentElement('afterend', nc);
          if (r === trEl) mine = nc;
        });
      });
      if (mine) select({ type: 'static', el: mine });
    } else if (name === 'colDel') {
      if (cellCount <= 1) { toast('最後の1列は削除できません。表ごと消すときは「ひとつ外側」で表を選んでください'); return; }
      var head = tableEl.rows[0] && tableEl.rows[0].cells[idx];
      state.sel = null;
      commitStatic('del', '表', '列を削除（' + (idx + 1) + '列目' + (head ? '「' + snip(head, 12) + '」' : '') + '）', H.ops.colRemove(state.doc, info.cell), function () {
        Array.prototype.forEach.call(tableEl.rows, function (r) { if (r.cells[idx]) r.cells[idx].remove(); });
      });
    }
    renderPanel();
  }

  function applyColor(prop, value) {
    var s = state.sel; if (!s || s.type !== 'static') return;
    var el = s.el;
    var what = prop === 'color' ? '文字色' : '背景色';
    commitStatic('color', '色', label(el) + '「' + snip(el, 14) + '」の' + what + (value ? ' → ' + value : 'を外す'),
      H.ops.setStyle(state.doc, idOf(el), prop, value),
      function () { if (value) el.style.setProperty(prop, value); else el.style.removeProperty(prop); });
    renderPanel();
  }

  // 資料の中でよく使われている色を拾う（色選びの候補）
  function collectPalette() {
    var d = frameDoc(); if (!d) return;
    var w = d.defaultView, tc = {}, bc = {};
    var els = d.body ? d.body.querySelectorAll('*') : [];
    for (var k = 0; k < els.length && k < 3000; k++) {
      var cs = w.getComputedStyle(els[k]);
      var c = toHex(cs.color); if (c) tc[c] = (tc[c] || 0) + 1;
      var b = toHex(cs.backgroundColor); if (b) bc[b] = (bc[b] || 0) + 1;
    }
    function top(o, n) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n); }
    state.palette = { text: top(tc, 8), bg: top(bc, 8) };
  }
  function toHex(rgb) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb || '');
    if (!m || (m[4] !== undefined && parseFloat(m[4]) < 0.5)) return null;
    return '#' + [m[1], m[2], m[3]].map(function (x) { return ('0' + parseInt(x, 10).toString(16)).slice(-2); }).join('');
  }

  // ===========================================================================
  // 右パネル
  // ===========================================================================
  // 作り直しても、入力中の欄（とカーソル位置）を保つ
  function renderPanel() {
    var ae = document.activeElement, keep = null;
    if (ae && $('panel').contains(ae) && ae.dataset && ae.dataset.path) {
      keep = { path: ae.dataset.path, ds: ae.dataset.ds, a: ae.selectionStart, b: ae.selectionEnd };
    }
    renderPanelInner();
    if (!keep) return;
    var list = $('panel').querySelectorAll('[data-path]');
    for (var k = 0; k < list.length; k++) {
      if (list[k].dataset.path === keep.path && list[k].dataset.ds === keep.ds) {
        list[k].focus();
        try { list[k].setSelectionRange(keep.a, keep.b); } catch (e) { /* noop */ }
        break;
      }
    }
  }

  function renderPanelInner() {
    var p = $('panel'), s = state.sel;
    if (!state.src) { p.innerHTML = '<p class="empty">資料を開くと、ここに編集の項目が出ます。</p>'; return; }
    if (!s) { p.innerHTML = '<p class="empty">' + (state.view === 'data' ? '一覧の「区切り」ボタンを押すと、その1件をここで編集できます。' : '資料の中の編集したい箇所をクリックしてください。ダブルクリックで文言を直せます。') + '</p>'; return; }
    if (s.type === 'static') return renderStaticPanel(p, s);
    if (s.type === 'row') return renderRowPanel(p, s);
    p.innerHTML = '<span class="tagchip computed">自動で作られた表示</span>' +
      '<p class="preview-text">' + esc(snip(s.el, 60)) + '</p>' +
      '<div class="note-box info">この部分は、資料のプログラムが計算して表示しているため、直接は直せません。' +
      (state.datasets.length ? '元になっているデータは、上の「データ」タブで確認・修正できます。' : 'この資料には、エディタで直せる形のデータが見つかりませんでした。') + '</div>';
  }

  function renderStaticPanel(p, s) {
    var el = s.el;
    if (!el.isConnected) { state.sel = null; return renderPanelInner(); }
    var info = staticInfo(el);
    var cs = el.ownerDocument.defaultView.getComputedStyle(el);
    var html = '<span class="tagchip">' + esc(label(el)) + '</span>';
    if (snip(el)) html += '<p class="preview-text">' + esc(snip(el, 80)) + '</p>';
    if (state.editing) {
      html += '<div class="note-box info">文言を編集中です。Enter で確定、Esc で取り消し。改行は Shift+Enter。</div>';
      p.innerHTML = html; return;
    }
    html += colorRow('color', '文字の色', state.palette.text.concat(BASIC_TEXT), toHex(cs.color) || '#000000', el.style.color);
    html += colorRow('background-color', '背景の色', state.palette.bg.concat(BASIC_BG), toHex(cs.backgroundColor) || '#ffffff', el.style.backgroundColor);
    html += '<div class="side-actions">' + btn('edit', '✎ 文言を編集', !info.textEdit.ok, 'btn small') +
      (info.cell === null ? btn('add', '＋ 下にテキスト追加', false, 'btn small') : '') +
      btn('parent', '⬆ ひとつ外側', !staticParent(el), 'btn small') + btn('del', '🗑 削除', false, 'btn small danger') + '</div>';
    if (info.cell !== null) {
      html += '<div class="side-actions">' + tableBtns(info, 'btn small') + '</div>';
      if (info.merged) html += '<div class="note-box warn">結合セルがあるため、この表は文言修正のみです</div>';
    }
    if (!info.textEdit.ok) html += '<div class="note-box info">' + esc(info.textEdit.reason) + '</div>';
    p.innerHTML = html;
  }

  function colorRow(prop, title, colors, current, inline) {
    var seen = {}, list = [];
    colors.forEach(function (c) { if (!seen[c] && list.length < 12) { seen[c] = 1; list.push(c); } });
    return '<div class="prop"><span>' + title + '</span><div class="swatches" data-prop="' + prop + '">' +
      list.map(function (c) { return '<button class="sw" style="background:' + c + '" data-c="' + c + '" title="' + c + '"></button>'; }).join('') +
      '<input type="color" value="' + current + '" title="自由に選ぶ">' +
      (inline ? '<button class="linkbtn" data-clear="1">色を外す</button>' : '') + '</div></div>';
  }

  $('panel').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.c) return applyColor(b.parentElement.dataset.prop, b.dataset.c);
    if (b.dataset.clear) return applyColor(b.parentElement.dataset.prop, null);
    if (b.dataset.act) return act(b.dataset.act);
    if (b.dataset.nestedAdd) return nestedAdd(b.dataset.ds, JSON.parse(b.dataset.nestedAdd));
    if (b.dataset.nestedDel) return nestedDel(b.dataset.ds, JSON.parse(b.dataset.nestedDel));
  });
  $('panel').addEventListener('change', function (e) {
    var t = e.target;
    if (t.type === 'color') return applyColor(t.parentElement.dataset.prop, t.value);
    if (t.dataset.path) commitField(t);
  });
  $('panel').addEventListener('keydown', onFieldKey);

  function renderRowPanel(p, s) {
    var ds = dsByName(s.ds);
    if (!ds || !ds.node.items[s.index]) { state.sel = null; return renderPanelInner(); }
    var item = ds.node.items[s.index];
    var html = '<span class="tagchip row">データの1件</span>' +
      '<p class="preview-text">' + esc(ds.name) + ' の ' + (s.index + 1) + '件目' + (rowTitle(item) ? '：' + esc(rowTitle(item)) : '') + '</p>';
    if (ds.description) html += '<details class="details-desc" open><summary>この一覧の説明</summary><pre>' + esc(ds.description) + '</pre></details>';
    html += '<div class="note-box info">直した内容は、この1件が使われているすべての場所（カード・表・スケジュールなど）に反映されます。</div>';
    html += fieldsFor(ds, [String(s.index)], item, D.columnsOf(ds.node));
    html += '<div class="side-actions">' + btn('showData', '一覧で見る', false, 'btn small') + '</div>';
    p.innerHTML = html;
  }

  function rowTitle(item) {
    var keys = ['title', 'name', 'label', 'タイトル', '名前'];
    for (var k = 0; k < keys.length; k++) { var pp = D.prop(item, keys[k]); if (pp && pp.value.t === 'str' && pp.value.v) return pp.value.v; }
    // 記号のような値（例: "schedule"）より、人が読む文章（日本語や空白を含む値）を優先する
    var strs = item.props.filter(function (x) { return x.value.t === 'str' && x.value.v.length > 1; });
    var readable = strs.filter(function (x) { return /[^\x00-\x7F]|\s/.test(x.value.v); })[0];
    var first = readable || strs[0];
    return first ? first.value.v : '';
  }

  // 1件分の入力欄。入れ子の一覧は縦に並べ、追加・削除できる
  function fieldsFor(ds, path, obj, cols) {
    var html = '';
    cols.forEach(function (key) {
      var pp = D.prop(obj, key), v = pp ? pp.value : null;
      var fp = path.concat([key]);
      if (v && v.t === 'arr') {
        var subCols = v.items.length && v.items.every(function (x) { return x.t === 'obj'; }) ? D.columnsOf(v) : null;
        var tpl = v.items.length ? null : D.templateFor(ds, fp);
        if (!subCols && !(tpl && !v.items.length) && v.items.length) {
          html += '<div class="field"><label>' + esc(key) + '</label><div class="note-box info">形がそろっていない一覧のため、ここでは直せません</div></div>';
          return;
        }
        if (!subCols && tpl) subCols = D.columnsOf(tpl.arr);
        html += '<div class="nested"><div class="nested-head"><span>' + esc(key) + '（' + v.items.length + '件）</span>' +
          '<button class="btn small" data-ds="' + esc(ds.name) + '" data-nested-add="' + esc(JSON.stringify({ path: fp, after: v.items.length - 1 })) + '"' + (!v.items.length && !tpl ? ' disabled title="手本になる区切りが見つからないため追加できません"' : '') + '>＋ 区切りを追加</button></div>';
        v.items.forEach(function (it, i) {
          html += '<div class="nested-item"><div class="ni-head"><span>' + (i + 1) + '件目</span>' +
            '<button class="linkbtn" data-ds="' + esc(ds.name) + '" data-nested-del="' + esc(JSON.stringify({ path: fp, index: i })) + '">削除</button></div>' +
            fieldsFor(ds, fp.concat([String(i)]), it, subCols || []) + '</div>';
        });
        if (!v.items.length) html += '<div class="nested-item"><p class="empty">まだありません</p></div>';
        html += '</div>';
        return;
      }
      if (v && v.t === 'obj') {
        html += '<div class="nested"><div class="nested-head"><span>' + esc(key) + '</span></div><div class="nested-item">' +
          fieldsFor(ds, fp, v, v.props.map(function (x) { return x.key; })) + '</div></div>';
        return;
      }
      html += inputField(ds, fp, key, v);
    });
    return html;
  }

  function inputField(ds, fp, key, v) {
    var val = D.displayText(v);
    var ph = !v ? '（未設定）' : (v.t === 'null' ? '（なし）' : '');
    var attrs = ' data-ds="' + esc(ds.name) + '" data-path="' + esc(JSON.stringify(fp)) + '" placeholder="' + ph + '"';
    var long = val.length > 28 || val.indexOf('\n') >= 0;
    return '<div class="field"><label>' + esc(key) + '</label>' +
      (long ? '<textarea' + attrs + ' rows="3">' + esc(val) + '</textarea>' : '<input type="text"' + attrs + ' value="' + esc(val) + '">') + '</div>';
  }

  function onFieldKey(e) {
    var t = e.target;
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && t.tagName === 'INPUT' && t.dataset.path) { e.preventDefault(); t.blur(); }
  }

  function commitField(t) {
    var ds = dsByName(t.dataset.ds); if (!ds) return;
    var path = JSON.parse(t.dataset.path);
    var patches;
    try { patches = D.edits.setValue(state.src, ds, path, t.value); } catch (err) { toast(err.message, true); return; }
    if (!patches.length) return;
    var summary = ds.name + ' ' + (Number(path[0]) + 1) + '件目 ' + path.slice(1).join('.') + ' → ' + (t.value.length > 16 ? t.value.slice(0, 16) + '…' : (t.value || '（空）'));
    var r = D.resolve(ds, path);
    var structural = !r.node; // 項目を足したときは、表の形が変わる
    commitData(summary, patches, { structural: structural });
  }

  function nestedAdd(dsName, a) {
    var ds = dsByName(dsName); if (!ds) return;
    var arr = D.resolve(ds, a.path).node;
    var tpl = arr && !arr.items.length ? D.templateFor(ds, a.path) : null;
    var patches;
    try { patches = D.edits.addItem(state.src, ds, a.path, a.after, tpl); } catch (err) { toast(err.message, true); return; }
    commitData(dsName + ' ' + (Number(a.path[0]) + 1) + '件目の ' + a.path.slice(1).join('.') + ' に区切りを追加', patches, { structural: true });
  }
  function nestedDel(dsName, a) {
    var ds = dsByName(dsName); if (!ds) return;
    var patches;
    try { patches = D.edits.removeItem(state.src, ds, a.path, a.index); } catch (err) { toast(err.message, true); return; }
    commitData(dsName + ' ' + (Number(a.path[0]) + 1) + '件目の ' + a.path.slice(1).join('.') + ' の' + (a.index + 1) + '件目を削除', patches, { structural: true });
  }

  // ===========================================================================
  // データタブ
  // ===========================================================================
  var KIND_LABEL = { rows: '一覧', list: '値の一覧', map: '対応表', value: '設定値', mixed: '一覧（形がそろっていない）' };

  function renderDataView() {
    var v = $('dataview');
    $('dataCount').textContent = state.datasets.length || '';
    if (!state.src) { v.innerHTML = ''; return; }
    if (!state.datasets.length) {
      v.innerHTML = '<div class="ds"><div class="ds-empty">この資料には、エディタで直せる形のデータが見つかりませんでした（データ編集には対応していません）。<br>文言の修正・削除などは「資料」タブで行えます。</div></div>';
      return;
    }
    var scroll = v.scrollTop;
    var html = '<p class="dv-intro">資料のプログラムに書かれているデータです。直すと、資料の表示にすぐ反映されます（入力欄から離れたとき、または Enter で確定）。</p>';
    var values = state.datasets.filter(function (d) { return d.kind === 'value'; });
    if (values.length) {
      html += '<section class="ds"><div class="ds-head"><h3>設定値</h3><span class="kind">' + values.length + '個</span></div>';
      var descs = values.filter(function (d) { return d.description; }).map(function (d) { return d.name + ': ' + d.description; });
      if (descs.length) html += '<pre class="desc"><span class="desc-label">この一覧の説明</span>' + esc(descs.join('\n')) + '</pre>';
      html += '<div class="kv">' + values.map(function (d) {
        return '<label>' + esc(d.name) + '</label><input type="text" class="cell" data-ds="' + esc(d.name) + '" data-path="[]" value="' + esc(D.displayText(d.node)) + '" placeholder="' + (d.node.t === 'null' ? '（なし）' : '') + '">';
      }).join('') + '</div></section>';
    }
    state.datasets.filter(function (d) { return d.kind !== 'value'; }).forEach(function (ds) { html += datasetSection(ds); });
    v.innerHTML = html;
    v.scrollTop = scroll;
    if (state.highlight) {
      var first = v.querySelector('tr.hl');
      if (first) first.scrollIntoView({ block: 'center' });
    }
  }

  function datasetSection(ds) {
    var n = ds.node;
    var head = '<section class="ds" data-dsname="' + esc(ds.name) + '"><div class="ds-head"><h3>' + esc(ds.name) + '</h3><span class="kind">' + KIND_LABEL[ds.kind] + (n.t === 'arr' ? ' ' + n.items.length + '件' : '') + '</span></div>';
    if (ds.description) head += '<pre class="desc"><span class="desc-label">この一覧の説明</span>' + esc(ds.description) + '</pre>';
    var body = '';
    if (ds.kind === 'rows') {
      var cols = D.columnsOf(n);
      var hl = state.highlight && state.highlight.ds === ds.name ? state.highlight.indexes : [];
      var cur = state.sel && state.sel.type === 'row' && state.sel.ds === ds.name ? state.sel.index : -1;
      body += '<div class="ds-scroll"><table><thead><tr><th></th>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '<th></th></tr></thead><tbody>';
      n.items.forEach(function (it, i) {
        body += '<tr class="' + (hl.indexOf(i) >= 0 ? 'hl' : '') + (cur === i ? ' cur' : '') + '"><td class="num">' + (i + 1) + '</td>';
        cols.forEach(function (c) {
          var pp = D.prop(it, c), v = pp ? pp.value : null;
          body += '<td>' + cellInput(ds, [String(i), c], v, i) + '</td>';
        });
        body += '<td class="acts">' + rowActs(ds, i) + '</td></tr>';
      });
      body += '</tbody></table></div>';
    } else if (ds.kind === 'list') {
      body += '<div class="ds-scroll"><table><tbody>';
      n.items.forEach(function (it, i) {
        body += '<tr><td class="num">' + (i + 1) + '</td><td>' + cellInput(ds, [String(i)], it, i) + '</td><td class="acts">' + rowActs(ds, i) + '</td></tr>';
      });
      if (!n.items.length) body += '<tr><td class="ds-empty">0件です（手本がないため、ここからは追加できません）</td></tr>';
      body += '</tbody></table></div>';
    } else if (ds.kind === 'map') {
      body += '<div class="kv">' + n.props.map(function (pp) {
        if (pp.value.t === 'arr' || pp.value.t === 'obj') return '<label>' + esc(pp.key) + '</label><span class="kind">（入れ子のため、ここでは直せません）</span>';
        return '<label>' + esc(pp.key) + '</label><input type="text" class="cell" data-ds="' + esc(ds.name) + '" data-path="' + esc(JSON.stringify([pp.key])) + '" value="' + esc(D.displayText(pp.value)) + '">';
      }).join('') + '</div>';
    } else {
      body += '<div class="ds-empty">形がそろっていない一覧のため、ここでは直せません。</div>';
    }
    if (ds.kind === 'rows' && !n.items.length) body = '<div class="ds-empty">0件です（手本がないため、ここからは追加できません）</div>';
    return head + body + '</section>';
  }

  function cellInput(ds, path, v, rowIndex) {
    if (v && v.t === 'arr') return '<button class="nested-btn" data-open-row="' + rowIndex + '" data-ds="' + esc(ds.name) + '">区切り ' + v.items.length + '件 ›</button>';
    if (v && v.t === 'obj') return '<button class="nested-btn" data-open-row="' + rowIndex + '" data-ds="' + esc(ds.name) + '">{…} ›</button>';
    var val = D.displayText(v);
    var ph = !v ? '—' : (v.t === 'null' ? '（なし）' : '');
    var attrs = ' class="cell" data-ds="' + esc(ds.name) + '" data-path="' + esc(JSON.stringify(path)) + '" placeholder="' + ph + '"';
    if (val.length > 40) return '<textarea' + attrs + ' rows="2">' + esc(val) + '</textarea>';
    return '<input type="text"' + attrs + ' value="' + esc(val) + '" size="' + Math.min(Math.max(val.length + 2, 6), 30) + '">';
  }

  function rowActs(ds, i) {
    return '<button class="btn small" data-add-after="' + i + '" data-ds="' + esc(ds.name) + '" title="この下に1件追加">＋下に追加</button> ' +
      '<button class="btn small danger" data-remove="' + i + '" data-ds="' + esc(ds.name) + '">削除</button>';
  }

  $('dataview').addEventListener('change', function (e) { var t = e.target; if (t.dataset.path) commitDataCell(t); });
  $('dataview').addEventListener('keydown', onFieldKey);
  $('dataview').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var ds = dsByName(b.dataset.ds); if (!ds) return;
    if (b.dataset.openRow !== undefined) {
      var i = parseInt(b.dataset.openRow, 10);
      state.sel = { type: 'row', ds: ds.name, index: i, el: findRowElement(ds.name, i) };
      renderPanel(); markCurrentRow();
      return;
    }
    if (b.dataset.addAfter !== undefined) {
      var a = parseInt(b.dataset.addAfter, 10), patches;
      try { patches = D.edits.addItem(state.src, ds, [], a); } catch (err) { toast(err.message, true); return; }
      state.highlight = { ds: ds.name, indexes: [a + 1] };
      commitData(ds.name + ' に1件追加（' + (a + 2) + '件目）', patches, { structural: true });
      return;
    }
    if (b.dataset.remove !== undefined) {
      var r = parseInt(b.dataset.remove, 10), it = ds.node.items[r];
      var name = it && it.t === 'obj' ? rowTitle(it) : D.displayText(it);
      if (!window.confirm(ds.name + ' の ' + (r + 1) + '件目' + (name ? '「' + name + '」' : '') + 'を削除しますか？（「1つ戻す」で戻せます）')) return;
      var ps;
      try { ps = D.edits.removeItem(state.src, ds, [], r); } catch (err) { toast(err.message, true); return; }
      if (state.sel && state.sel.type === 'row' && state.sel.ds === ds.name) state.sel = null;
      state.highlight = null;
      commitData(ds.name + ' の ' + (r + 1) + '件目' + (name ? '「' + (name.length > 14 ? name.slice(0, 14) + '…' : name) + '」' : '') + 'を削除', ps, { structural: true });
    }
  });

  function commitDataCell(t) {
    var ds = dsByName(t.dataset.ds); if (!ds) return;
    var path = JSON.parse(t.dataset.path);
    var patches;
    try { patches = D.edits.setValue(state.src, ds, path, t.value); } catch (err) { toast(err.message, true); return; }
    if (!patches.length) return;
    var where = ds.kind === 'value' ? ds.name : ds.kind === 'map' ? ds.name + '.' + path[0] : ds.name + ' ' + (Number(path[0]) + 1) + '件目' + (path[1] ? ' ' + path[1] : '');
    var structural = !D.resolve(ds, path).node;
    commitData(where + ' → ' + (t.value.length > 16 ? t.value.slice(0, 16) + '…' : (t.value || '（空）')), patches, { structural: structural });
  }

  function markCurrentRow() {
    var s = state.sel;
    $('dataview').querySelectorAll('tr.cur').forEach(function (r) { r.classList.remove('cur'); });
    if (!s || s.type !== 'row') return;
    var sec = $('dataview').querySelector('section[data-dsname="' + s.ds + '"]');
    if (sec) { var tr = sec.querySelectorAll('tbody tr')[s.index]; if (tr) tr.classList.add('cur'); }
  }
  function refreshDataCounts() { $('dataCount').textContent = state.datasets.length || ''; }

  // ===========================================================================
  // 保存
  // ===========================================================================
  var saveMenu = $('saveMenu');
  $('btnSave').addEventListener('click', function (e) {
    e.stopPropagation();
    var canOver = !!state.handle;
    var lo = $('optOverwrite');
    lo.classList.toggle('disabled', !canOver);
    lo.querySelector('input').disabled = !canOver;
    lo.querySelector('.desc').textContent = canOver ? '最初の上書きの前に、編集前の内容を「ダウンロード」フォルダへ自動で残します' : 'この開き方では上書きできません（「ファイルを開く」から開くと上書きできます）';
    var radios = document.querySelectorAll('input[name=savemode]');
    if (!document.querySelector('input[name=savemode]:checked') || (!canOver && radios[0].checked)) radios[canOver ? 0 : 1].checked = true;
    saveMenu.classList.toggle('open');
  });
  saveMenu.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { saveMenu.classList.remove('open'); });
  $('btnSaveDo').addEventListener('click', function () {
    saveMenu.classList.remove('open');
    var m = document.querySelector('input[name=savemode]:checked').value;
    if (m === 'overwrite') saveOverwrite(); else saveAs();
  });

  function baseName() { return state.name.replace(/\.html?$/i, ''); }
  function nowStamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }

  function download(text, name) {
    var url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function saveOverwrite() {
    if (state.editing) finishEdit(false);
    if (!state.handle) { toast('この開き方では上書きできないため、別名で保存します'); return saveAs(); }
    var h = state.handle;
    var perm = h.queryPermission ? h.queryPermission({ mode: 'readwrite' }) : Promise.resolve('granted');
    perm.then(function (p) { return p === 'granted' ? p : h.requestPermission({ mode: 'readwrite' }); })
      .then(function (p) {
        if (p !== 'granted') throw new Error('上書きの許可が得られませんでした');
        if (!state.backupName) {
          state.backupName = baseName() + '_backup_' + nowStamp() + '.html';
          download(state.original, state.backupName);
          $('backupName').textContent = state.backupName + '（ダウンロードフォルダ）';
        }
        return h.createWritable();
      })
      .then(function (w) { return w.write(state.src).then(function () { return w.close(); }); })
      .then(function () { markSaved('上書き保存しました'); })
      .catch(function (e) { toast('保存できませんでした: ' + e.message, true); });
  }

  function saveAs() {
    if (state.editing) finishEdit(false);
    var suggested = baseName() + '_edited.html';
    if (window.showSaveFilePicker) {
      window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'HTML ファイル', accept: { 'text/html': ['.html'] } }] })
        .then(function (h) {
          return h.createWritable().then(function (w) { return w.write(state.src).then(function () { return w.close(); }); }).then(function () {
            state.handle = h; state.name = h.name;
            // 別名で保存した後は、新しいファイルを編集している状態になる
            state.original = state.src; state.backupName = '';
            $('backupName').textContent = '未作成（最初の上書き保存の前に作成）';
            markSaved('別名で保存しました: ' + h.name);
          });
        })
        .catch(function (e) { if (e && e.name !== 'AbortError') toast('保存できませんでした: ' + e.message, true); });
    } else {
      download(state.src, suggested);
      markSaved('ダウンロードフォルダに保存しました: ' + suggested);
    }
  }

  function markSaved(msg) {
    state.savedSrc = state.src;
    state.history.unshift({ saved: true, t: stamp() });
    renderHistory(); updateChrome(); toast(msg);
  }

  window.addEventListener('beforeunload', function (e) { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ===========================================================================
  // キーボード
  // ===========================================================================
  function onKey(e) {
    var mod = e.metaKey || e.ctrlKey;
    if (state.editing) {
      if (e.isComposing || e.keyCode === 229) return; // 日本語の変換中は何もしない
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(false); return; }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(true); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); finishEdit(false); defaultSave(); }
      return;
    }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.src) defaultSave(); return; }
    var tg = e.target && e.target.tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (!state.src || state.view !== 'doc') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel && state.sel.type === 'static' && state.mode === 'edit') { e.preventDefault(); deleteStatic(state.sel.el); return; }
    if (e.key === 'Escape' && state.sel) { select(null); return; }
    if (e.key === 'Enter' && state.sel && state.sel.type === 'static' && state.mode === 'edit') { e.preventDefault(); tryStartEdit(state.sel.el); }
  }
  window.addEventListener('keydown', onKey);
  function defaultSave() { if (state.handle) saveOverwrite(); else saveAs(); }

  // ===========================================================================
  // 共通の表示
  // ===========================================================================
  function renderHistory() {
    var h = $('history');
    if (!state.history.length) { h.innerHTML = '<p class="empty">まだ変更はありません。</p>'; return; }
    h.innerHTML = state.history.map(function (x) {
      if (x.saved) return '<div class="h-item saved-mark">— ' + x.t + ' 保存 —</div>';
      return '<div class="h-item"><span class="t">' + x.t + '</span><span class="k ' + x.kind + '">' + esc(x.k) + '</span><span class="s" title="' + esc(x.s) + '">' + esc(x.s) + '</span></div>';
    }).join('');
  }

  function updateChrome() {
    $('fileName').innerHTML = state.name ? '編集中: <b>' + esc(state.name) + '</b>' + (state.handle ? '' : '（上書き不可の開き方）') : 'ファイル未選択';
    $('btnUndo').disabled = !state.undo.length;
    $('btnSave').disabled = !state.src;
    var u = $('unsaved');
    if (!state.src) { u.textContent = ''; u.className = 'unsaved'; return; }
    if (isDirty()) { u.textContent = '未保存の変更あり'; u.className = 'unsaved dirty'; }
    else { u.textContent = state.history.length ? '保存済み' : ''; u.className = 'unsaved saved'; }
    document.title = (isDirty() ? '● ' : '') + (state.name ? state.name + ' - ' : '') + 'HTMLエディタ';
  }

  $('btnOpen').addEventListener('click', openPicker);
  $('btnUndo').addEventListener('click', undo);
  window.addEventListener('resize', updateOverlay);

  var toastTimer = null;
  function toast(msg, warn) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (warn ? ' warn' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast' + (warn ? ' warn' : ''); }, warn ? 4500 : 2600);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  setMode('edit');
  updateChrome();
})();
