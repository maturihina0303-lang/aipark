/* ===== AIパーク : ロジック（共有対応版） =====
   - Firebase 設定あり → 🌐 みんなで共有モード（Firestore・リアルタイム同期）
   - Firebase 設定なし → 💾 このPCのみモード（localStorage）
*/
(() => {
  "use strict";

  const STORAGE_KEY = "aipark.sites.v1";
  const MAX_THUMB_CHARS = 850000; // Firestore 1ドキュメント上限(約1MB)に対する安全枠

  /* ---------- ユーティリティ ---------- */
  const $ = (sel) => document.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  }
  function faviconUrl(url) {
    const host = hostOf(url);
    return host ? `https://www.google.com/s/favicons?domain=${encodeURIComponent(host)}&sz=64` : "";
  }

  /* =====================================================================
     データストア（2モード）
     ===================================================================== */
  let sites = [];
  let store = null;

  // --- localStorage 実装 ---
  function makeLocalStore(onChange) {
    function read() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
      catch { return []; }
    }
    function write(list) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
      catch (e) {
        alert("保存に失敗しました。サムネイル画像が大きすぎる可能性があります（保存容量の上限）。");
        throw e;
      }
    }
    return {
      mode: "local",
      start() { sites = read(); onChange(); },
      async add(data) { sites.push({ id: uid(), createdAt: Date.now(), ...data }); write(sites); onChange(); },
      async update(id, data) {
        const i = sites.findIndex((s) => s.id === id);
        if (i >= 0) { sites[i] = { ...sites[i], ...data }; write(sites); onChange(); }
      },
      async remove(id) { sites = sites.filter((s) => s.id !== id); write(sites); onChange(); },
      async getSetting(key) { return localStorage.getItem("aipark.setting." + key); },
      async setSetting(key, hash) { localStorage.setItem("aipark.setting." + key, hash); },
    };
  }

  // --- Firestore 実装 ---
  function makeFirestoreStore(onChange) {
    const db = firebase.firestore();
    const col = db.collection("sites");
    return {
      mode: "shared",
      start() {
        col.orderBy("createdAt", "desc").onSnapshot(
          (snap) => {
            sites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            onChange();
          },
          (err) => {
            console.error(err);
            alert("共有データの読み込みに失敗しました。\nFirestore のルール設定を確認してください。\n" + err.message);
          }
        );
      },
      async add(data) {
        try { await col.add({ createdAt: Date.now(), ...data }); }
        catch (e) { alert("投稿の保存に失敗しました。\n" + e.message); throw e; }
      },
      async update(id, data) {
        try { await col.doc(id).update(data); }
        catch (e) { alert("更新に失敗しました。\n" + e.message); throw e; }
      },
      async remove(id) {
        try { await col.doc(id).delete(); }
        catch (e) { alert("削除に失敗しました。\n" + e.message); throw e; }
      },
      async getSetting(key) {
        try {
          const snap = await db.collection("settings").doc(key).get();
          return snap.exists ? (snap.data().hash || null) : null;
        } catch (e) { console.error("設定の読み込み失敗", e); return null; }
      },
      async setSetting(key, hash) {
        try { await db.collection("settings").doc(key).set({ hash }); }
        catch (e) {
          alert("保存に失敗しました。\nFirestore のルールで settings コレクションへの書き込みを許可してください。\n" + e.message);
          throw e;
        }
      },
    };
  }

  // --- Supabase 実装 ---
  function makeSupabaseStore(onChange) {
    const cfg = window.AIPARK_SUPABASE_CONFIG;
    const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

    const rowToSite = (r) => ({
      id: r.id,
      createdAt: Number(r.created_at) || 0,
      name: r.name || "",
      url: r.url || "",
      desc: r.description || "",
      author: r.author || "",
      pass: r.pass || "",
      thumb: r.thumb || "",
    });
    const siteToRow = (d) => ({
      name: d.name, url: d.url, description: d.desc,
      author: d.author, pass: d.pass, thumb: d.thumb,
    });

    async function refetch() {
      const { data, error } = await sb.from("sites").select("*").order("created_at", { ascending: false });
      if (error) { console.error(error); alert("共有データの読み込みに失敗しました。\n" + error.message); return; }
      sites = data.map(rowToSite);
      onChange();
    }

    return {
      mode: "shared",
      start() {
        refetch();
        // リアルタイム同期（他の人の投稿も自動反映）
        try {
          sb.channel("aipark-sites")
            .on("postgres_changes", { event: "*", schema: "public", table: "sites" }, () => refetch())
            .subscribe();
        } catch (e) { console.warn("リアルタイム購読に失敗（手動更新は可）", e); }
      },
      async add(data) {
        const { error } = await sb.from("sites").insert({ created_at: Date.now(), ...siteToRow(data) });
        if (error) { alert("投稿の保存に失敗しました。\n" + error.message); throw error; }
        await refetch();
      },
      async update(id, data) {
        const { error } = await sb.from("sites").update(siteToRow(data)).eq("id", id);
        if (error) { alert("更新に失敗しました。\n" + error.message); throw error; }
        await refetch();
      },
      async remove(id) {
        const { error } = await sb.from("sites").delete().eq("id", id);
        if (error) { alert("削除に失敗しました。\n" + error.message); throw error; }
        await refetch();
      },
      async getSetting(key) {
        const { data, error } = await sb.from("settings").select("hash").eq("key", key).maybeSingle();
        if (error) { console.error("設定の読み込み失敗", error); return null; }
        return data ? data.hash : null;
      },
      async setSetting(key, hash) {
        const { error } = await sb.from("settings").upsert({ key, hash });
        if (error) {
          alert("保存に失敗しました。\nSupabase のテーブル/ポリシー設定を確認してください。\n" + error.message);
          throw error;
        }
      },
    };
  }

  function initStore() {
    const sbCfg = window.AIPARK_SUPABASE_CONFIG;
    const fbCfg = window.AIPARK_FIREBASE_CONFIG;
    const hasSupabase = !!(window.supabase && sbCfg && sbCfg.url && sbCfg.anonKey);
    const hasFirebase = !!(window.firebase && fbCfg && fbCfg.apiKey && fbCfg.projectId);

    if (hasSupabase) {
      try { store = makeSupabaseStore(render); }
      catch (e) { console.error("Supabase 初期化失敗、ローカルモードに切替", e); store = makeLocalStore(render); }
    } else if (hasFirebase) {
      try { firebase.initializeApp(fbCfg); store = makeFirestoreStore(render); }
      catch (e) { console.error("Firebase 初期化失敗、ローカルモードに切替", e); store = makeLocalStore(render); }
    } else {
      store = makeLocalStore(render);
    }
    updateModeBadge();
    // ※ store.start() は合言葉を通過してから enterApp() で呼ぶ
  }

  function updateModeBadge() {
    const badge = $("#modeBadge");
    if (!badge || !store) return;
    if (store.mode === "shared") {
      badge.textContent = "🌐 みんなで共有中";
      badge.className = "mode-badge shared";
      badge.title = "投稿は全員で共有され、どのPCからでも見えます";
    } else {
      badge.textContent = "💾 このPCのみ";
      badge.className = "mode-badge local";
      badge.title = "このブラウザにだけ保存されます。共有するには SETUP.md を参照してください";
    }
  }

  /* ---------- DOM 参照 ---------- */
  const grid = $("#grid");
  const emptyState = $("#emptyState");
  const countLabel = $("#countLabel");
  const searchInput = $("#searchInput");
  const sortSelect = $("#sortSelect");
  const cardTemplate = $("#cardTemplate");

  const modalOverlay = $("#modalOverlay");
  const detailOverlay = $("#detailOverlay");
  const form = $("#siteForm");

  /* ---------- サムネイル入力 ---------- */
  let currentThumb = "";
  const thumbPreview = $("#thumbPreview");
  const fThumb = $("#fThumb");
  const clearThumbBtn = $("#clearThumbBtn");

  function setThumbPreview(dataUrl) {
    currentThumb = dataUrl || "";
    if (currentThumb) {
      thumbPreview.style.backgroundImage = `url('${currentThumb}')`;
      thumbPreview.innerHTML = "";
      clearThumbBtn.hidden = false;
    } else {
      thumbPreview.style.backgroundImage = "";
      thumbPreview.innerHTML = '<span class="thumb-placeholder">画像未設定</span>';
      clearThumbBtn.hidden = true;
    }
  }

  // 画像をリサイズして dataURL 化（共有DBの容量節約）
  function fileToThumb(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxW = 600;
          const scale = Math.min(1, maxW / img.width);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.72));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  fThumb.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const thumb = await fileToThumb(file);
      if (thumb.length > MAX_THUMB_CHARS) {
        alert("画像が大きすぎます。もう少し小さい画像を選んでください。");
      } else {
        setThumbPreview(thumb);
      }
    } catch {
      alert("画像の読み込みに失敗しました。");
    }
    fThumb.value = "";
  });
  $("#pickThumbBtn").addEventListener("click", () => fThumb.click());
  clearThumbBtn.addEventListener("click", () => setThumbPreview(""));

  /* ---------- 描画 ---------- */
  function render() {
    const q = searchInput.value.trim().toLowerCase();
    let list = sites.filter((s) => {
      if (!q) return true;
      return (
        (s.name || "").toLowerCase().includes(q) ||
        (s.desc || "").toLowerCase().includes(q) ||
        (s.author || "").toLowerCase().includes(q) ||
        (s.url || "").toLowerCase().includes(q)
      );
    });

    const sort = sortSelect.value;
    list.sort((a, b) => {
      if (sort === "new") return (b.createdAt || 0) - (a.createdAt || 0);
      if (sort === "old") return (a.createdAt || 0) - (b.createdAt || 0);
      if (sort === "name") return (a.name || "").localeCompare(b.name || "", "ja");
      if (sort === "author") return (a.author || "").localeCompare(b.author || "", "ja");
      return 0;
    });

    countLabel.textContent = sites.length;
    grid.innerHTML = "";

    if (sites.length === 0) {
      emptyState.hidden = false;
      grid.hidden = true;
      return;
    }
    emptyState.hidden = true;
    grid.hidden = false;

    if (list.length === 0) {
      grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--ink-soft);padding:40px 0;">「' + esc(searchInput.value) + '」に一致するサイトはありません。</p>';
      return;
    }

    for (const site of list) grid.appendChild(buildCard(site));
  }

  function buildCard(site) {
    const node = cardTemplate.content.cloneNode(true);
    const thumb = node.querySelector(".card-thumb");
    thumb.href = site.url;

    if (site.thumb) {
      thumb.style.backgroundImage = `url('${site.thumb}')`;
    } else {
      thumb.classList.add("auto");
      const fav = faviconUrl(site.url);
      thumb.innerHTML =
        `<div class="auto-logo">${fav ? `<img src="${esc(fav)}" alt="" onerror="this.parentNode.textContent='🌐'">` : "🌐"}</div>` +
        `<div class="auto-title">${esc(site.name)}</div>`;
    }

    node.querySelector(".card-name").textContent = site.name;
    node.querySelector(".card-desc").textContent = site.desc || "（説明なし）";

    const authorEl = node.querySelector(".card-author");
    if (site.author) authorEl.textContent = "👤 " + site.author;

    node.querySelector(".card-visit").href = site.url;
    node.querySelector(".card-detail").addEventListener("click", () => openDetail(site.id));
    node.querySelector(".card-edit").addEventListener("click", () => openEdit(site.id));
    node.querySelector(".card-delete").addEventListener("click", () => removeSite(site.id));

    return node;
  }

  /* ---------- 追加 / 編集モーダル ---------- */
  function openAdd() {
    form.reset();
    $("#editId").value = "";
    setThumbPreview("");
    $("#modalTitle").textContent = "サイトを投稿";
    $("#submitBtn").textContent = "投稿する";
    showModal(modalOverlay);
    $("#fName").focus();
  }

  function openEdit(id) {
    const site = sites.find((s) => s.id === id);
    if (!site) return;
    form.reset();
    $("#editId").value = site.id;
    $("#fName").value = site.name || "";
    $("#fUrl").value = site.url || "";
    $("#fDesc").value = site.desc || "";
    $("#fAuthor").value = site.author || "";
    $("#fPass").value = site.pass || "";
    setThumbPreview(site.thumb || "");
    $("#modalTitle").textContent = "サイトを編集";
    $("#submitBtn").textContent = "保存する";
    showModal(modalOverlay);
    $("#fName").focus();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = $("#submitBtn");
    const id = $("#editId").value;
    const data = {
      name: $("#fName").value.trim(),
      url: $("#fUrl").value.trim(),
      desc: $("#fDesc").value.trim(),
      author: $("#fAuthor").value.trim(),
      pass: $("#fPass").value.trim(),
      thumb: currentThumb,
    };
    if (!data.name || !data.url) return;

    const original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "保存中…";
    try {
      if (id) await store.update(id, data);
      else await store.add(data);
      hideModal(modalOverlay);
    } catch {
      /* エラーは store 側で通知済み */
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });

  /* ---------- 削除 ---------- */
  async function removeSite(id) {
    const site = sites.find((s) => s.id === id);
    if (!site) return;
    if (!confirm(`「${site.name}」を削除しますか？`)) return;
    await store.remove(id);
  }

  /* ---------- 詳細モーダル ---------- */
  function openDetail(id) {
    const site = sites.find((s) => s.id === id);
    if (!site) return;
    $("#detailTitle").textContent = site.name;

    const thumbStyle = site.thumb
      ? `background-image:url('${site.thumb}')`
      : `background:linear-gradient(135deg,var(--green-300),var(--green-500))`;

    const passId = "pass_" + site.id;
    const rows = [];
    rows.push(`<div class="detail-thumb" style="${thumbStyle}"></div>`);
    rows.push(row("URL", `<a href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)}</a>`));
    if (site.desc) rows.push(row("説明", esc(site.desc).replace(/\n/g, "<br>")));
    if (site.author) rows.push(row("投稿者", "👤 " + esc(site.author)));
    if (site.pass) {
      rows.push(row("合言葉", `
        <div class="pass-box">
          <span id="${passId}" class="pass-masked">●●●●●●</span>
          <button class="btn btn-sm btn-ghost" data-reveal="${esc(site.pass)}" data-target="${passId}">表示</button>
          <button class="btn btn-sm btn-ghost" data-copy="${esc(site.pass)}">コピー</button>
        </div>`));
    }
    if (site.createdAt) rows.push(row("登録日", new Date(site.createdAt).toLocaleString("ja-JP")));

    const body = $("#detailBody");
    body.innerHTML = rows.join("");

    body.querySelectorAll("[data-reveal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.dataset.target);
        if (btn.textContent === "表示") {
          target.textContent = btn.dataset.reveal;
          target.classList.remove("pass-masked");
          btn.textContent = "隠す";
        } else {
          target.textContent = "●●●●●●";
          target.classList.add("pass-masked");
          btn.textContent = "表示";
        }
      });
    });
    body.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy);
          const t = btn.textContent; btn.textContent = "✓ コピー済";
          setTimeout(() => (btn.textContent = t), 1400);
        } catch { alert("コピーできませんでした。"); }
      });
    });

    showModal(detailOverlay);
  }
  function row(label, valueHtml) {
    return `<div class="detail-row"><div class="label">${label}</div><div class="value">${valueHtml}</div></div>`;
  }

  /* ---------- モーダル制御 ---------- */
  function showModal(overlay) { overlay.hidden = false; document.body.style.overflow = "hidden"; }
  function hideModal(overlay) { overlay.hidden = true; document.body.style.overflow = ""; }

  $("#openAddBtn").addEventListener("click", openAdd);
  $("#emptyAddBtn").addEventListener("click", openAdd);
  $("#closeModalBtn").addEventListener("click", () => hideModal(modalOverlay));
  $("#cancelBtn").addEventListener("click", () => hideModal(modalOverlay));
  $("#closeDetailBtn").addEventListener("click", () => hideModal(detailOverlay));

  [modalOverlay, detailOverlay].forEach((ov) => {
    ov.addEventListener("click", (e) => { if (e.target === ov) hideModal(ov); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideModal(modalOverlay); hideModal(detailOverlay); }
  });

  searchInput.addEventListener("input", render);
  sortSelect.addEventListener("change", render);
  $("#brandHome").addEventListener("click", () => {
    searchInput.value = ""; sortSelect.value = "new"; render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* =====================================================================
     合言葉ロック
     ===================================================================== */
  const UNLOCK_KEY = "aipark.unlocked";
  const NO_LOCK = "__none__"; // 「ロックしない」を表す番人
  let appStarted = false;
  let currentGateHash = null;

  const gateOverlay = $("#gateOverlay");

  async function hashPass(text) {
    const t = "aipark::" + text;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 0; // 万一 crypto が使えない環境向けの簡易ハッシュ
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return "f" + h.toString(16);
  }

  function showGateSection(id) {
    ["gateLoading", "gateLock", "gateSetup", "gateOwner"].forEach((s) => {
      $("#" + s).hidden = s !== id;
    });
    gateOverlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function shakeGate() {
    gateOverlay.classList.add("shake");
    setTimeout(() => gateOverlay.classList.remove("shake"), 420);
  }

  async function runGate() {
    showGateSection("gateLoading");
    const hash = await store.getSetting("gate");
    if (!hash) { openGateSetup(false); return; }          // 未設定 → オーナー初期設定
    if (hash === NO_LOCK) { enterApp(); return; }         // ロックしない設定
    currentGateHash = hash;
    const saved = localStorage.getItem(UNLOCK_KEY);
    if (saved && saved === hash) { enterApp(); return; }  // この端末は記憶済み
    openGateLock();
  }

  function openGateLock() {
    showGateSection("gateLock");
    $("#gateError").hidden = true;
    $("#gatePass").value = "";
    setTimeout(() => $("#gatePass").focus(), 50);
  }

  let gateChangeMode = false;
  function openGateSetup(isChange) {
    gateChangeMode = isChange;
    showGateSection("gateSetup");
    $("#gateNew").value = "";
    $("#gateNew2").value = "";
    $("#gateSetupError").hidden = true;
    $("#gateSetupMsg").innerHTML = isChange
      ? "新しい合言葉を入力してください。"
      : 'はじめに「合言葉」を決めてください。<br>これを知っている人だけが入れます。';
    $("#gateSetupSubmit").textContent = isChange ? "変更する" : "設定して入る";
    $("#gateSkip").hidden = isChange;
    $("#gateCancelChange").hidden = !isChange;
    setTimeout(() => $("#gateNew").focus(), 50);
  }

  function enterApp() {
    gateOverlay.hidden = true;
    document.body.style.overflow = "";
    // ロック中でも変更ボタンは押せるように、ロックが有効なときだけボタンを出す
    const locked = currentGateHash && currentGateHash !== NO_LOCK;
    $("#lockBtn").hidden = !locked;
    $("#changePassBtn").hidden = false;
    if (!appStarted) { appStarted = true; store.start(); }
  }

  // ロック解除フォーム
  $("#gateLockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#gatePass").value;
    const h = await hashPass(input);
    if (h === currentGateHash) {
      if ($("#gateRemember").checked) localStorage.setItem(UNLOCK_KEY, currentGateHash);
      else localStorage.removeItem(UNLOCK_KEY);
      enterApp();
    } else {
      $("#gateError").hidden = false;
      $("#gatePass").value = "";
      $("#gatePass").focus();
      gateOverlay.classList.add("shake");
      setTimeout(() => gateOverlay.classList.remove("shake"), 420);
    }
  });

  // 設定 / 変更フォーム
  $("#gateSetupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = $("#gateNew").value.trim();
    const p2 = $("#gateNew2").value.trim();
    const err = $("#gateSetupError");
    if (p1.length < 2) { err.textContent = "合言葉は2文字以上にしてください。"; err.hidden = false; return; }
    if (p1 !== p2) { err.textContent = "2つの合言葉が一致しません。"; err.hidden = false; return; }
    const submit = $("#gateSetupSubmit");
    const orig = submit.textContent;
    submit.disabled = true; submit.textContent = "保存中…";
    try {
      const h = await hashPass(p1);
      await store.setSetting("gate", h);
      currentGateHash = h;
      localStorage.setItem(UNLOCK_KEY, h);
      enterApp();
    } catch {
      /* setSetting 側で通知済み */
    } finally {
      submit.disabled = false; submit.textContent = orig;
    }
  });

  // スキップ（ロックしない）
  $("#gateSkip").addEventListener("click", async () => {
    try { await store.setSetting("gate", NO_LOCK); currentGateHash = NO_LOCK; } catch {}
    localStorage.removeItem(UNLOCK_KEY);
    enterApp();
  });
  $("#gateCancelChange").addEventListener("click", () => enterApp());

  /* ---------- オーナー確認（合言葉変更はオーナーのみ） ---------- */
  let gateOwnerMode = "verify"; // "setup" or "verify"
  function openGateOwner(mode) {
    gateOwnerMode = mode;
    showGateSection("gateOwner");
    $("#gateOwnerPass").value = "";
    $("#gateOwnerPass2").value = "";
    $("#gateOwnerError").hidden = true;
    const isSetup = mode === "setup";
    $("#gateOwnerPass2").hidden = !isSetup;
    $("#gateOwnerMsg").innerHTML = isSetup
      ? "オーナーパスワードを設定してください。<br>これを知っている人だけが「合言葉」を変更できます。"
      : "オーナーパスワードを入力してください。";
    $("#gateOwnerSubmit").textContent = isSetup ? "設定する" : "確認";
    setTimeout(() => $("#gateOwnerPass").focus(), 50);
  }

  async function startChangeFlow() {
    // 先にオーナーパスワードを確認（未設定なら設定）
    const ownerHash = await store.getSetting("owner");
    openGateOwner(ownerHash ? "verify" : "setup");
  }

  $("#gateOwnerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = $("#gateOwnerPass").value.trim();
    const err = $("#gateOwnerError");

    if (gateOwnerMode === "setup") {
      const p2 = $("#gateOwnerPass2").value.trim();
      if (p1.length < 2) { err.textContent = "オーナーパスワードは2文字以上にしてください。"; err.hidden = false; return; }
      if (p1 !== p2) { err.textContent = "2つのパスワードが一致しません。"; err.hidden = false; return; }
      const submit = $("#gateOwnerSubmit");
      const orig = submit.textContent;
      submit.disabled = true; submit.textContent = "保存中…";
      try {
        await store.setSetting("owner", await hashPass(p1));
        openGateSetup(true); // オーナー設定後、合言葉変更画面へ
      } catch { /* 通知済み */ }
      finally { submit.disabled = false; submit.textContent = orig; }
    } else {
      const ownerHash = await store.getSetting("owner");
      if ((await hashPass(p1)) === ownerHash) {
        openGateSetup(true); // 確認OK → 合言葉変更画面へ
      } else {
        err.textContent = "オーナーパスワードが違います";
        err.hidden = false;
        $("#gateOwnerPass").value = "";
        $("#gateOwnerPass").focus();
        shakeGate();
      }
    }
  });
  $("#gateOwnerCancel").addEventListener("click", () => enterApp());

  // ヘッダー：ロック / 合言葉変更
  $("#lockBtn").addEventListener("click", () => {
    localStorage.removeItem(UNLOCK_KEY);
    if (currentGateHash && currentGateHash !== NO_LOCK) openGateLock();
    else openGateSetup(false);
  });
  $("#changePassBtn").addEventListener("click", startChangeFlow);

  /* ---------- 起動 ---------- */
  initStore();
  runGate();
})();
