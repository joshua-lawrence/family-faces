// Remove photo: takes whole photos out of the library (api_remove.py). The files go to the "Removed photos"
// folder and their faces are ignored; the toast's Undo (POST /api/photo/restore) puts it all back.
// Buttons: the photo viewer (data-pv-remove), each Leftover face card (data-rm-face), and the selection bar on
// Groups and Leftover faces (#nm-sel-rmphoto, for the selected faces' photos).
(() => {
  async function restore(paths) {
    const r = await postJSON("/api/photo/restore", { paths }, { quiet: true });
    if (r && r.error) return toast(`Couldn’t put ${paths.length === 1 ? "it" : "them"} back. ${r.error}`, true);
    toast(paths.length === 1 ? "Photo put back in the library." : `${paths.length} photos put back in the library.`, { action: null });
    load();
  }
  // what: {path} | {faces: [ids]}; label: how to name it in the question
  async function removePhotos(what, label) {
    const n = what.faces ? new Set(what.faces.map(f => S?.face_photo?.[f] ?? f)).size : 1;
    if (!confirm(`Remove ${label} from the library?\n\n${n === 1 ? "It leaves" : "They leave"} every page and ${n === 1 ? "its" : "their"} faces are ignored. The ${n === 1 ? "file is" : "files are"} moved to the “Removed photos” folder, not deleted, and you can undo this.`)) return false;
    const r = await postJSON("/api/photo/remove", what, { quiet: true });
    if (!r || r.error) { toast(`Couldn’t remove ${label}. ${r?.error || ""}`, true); return false; }
    const paths = r.paths || [];
    toast(paths.length === 1 ? `Removed ${paths[0].split("/").pop()}.` : `Removed ${paths.length} photos.`,
      { action: { label: "Undo", run: () => restore(paths) } });
    load();
    return true;
  }
  window.removePhotos = removePhotos;

  // Imports page: the photos removed so far, each with Restore (the toast's Undo is gone after a few seconds).
  async function renderRemovedPhotos() {
    const box = document.querySelector("#rm-list");
    if (!box) return;
    const list = (await fetch("/api/photo/removed").then(r => r.json()).catch(() => ({ photos: [] }))).photos || [];
    if (!list.length) { box.innerHTML = ""; return; }
    const when = t => t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
    box.innerHTML = `<section class="imp-report rm-list" aria-labelledby="rm-title">
      <h2 id="rm-title">Removed photos<span class="meta"> · ${list.length.toLocaleString()}</span></h2>
      <p class="meta">These are out of the library. The files are in the <i>Removed photos</i> folder beside your albums: restore them here, or empty that folder in Finder to get rid of them for good.</p>
      ${list.length > 1 ? `<p><button type="button" class="btn" data-rm-restore-all>Restore all ${list.length.toLocaleString()}</button></p>` : ""}
      <ul>${list.slice(0, 200).map(p => `<li><b>${esc(p.path.split("/").pop())}</b> <span class="meta">${esc(p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "")} · removed ${esc(when(p.removed))}${p.faces ? ` · ${p.faces} ${p.faces === 1 ? "face" : "faces"}` : ""}</span>
        <button type="button" class="btn nm-sm" data-rm-restore="${esc(p.path)}">Restore</button></li>`).join("")}</ul>
      ${list.length > 200 ? `<p class="meta">And ${(list.length - 200).toLocaleString()} more.</p>` : ""}
    </section>`;
  }
  window.renderRemovedPhotos = renderRemovedPhotos;

  document.addEventListener("click", async e => {
    const back = e.target.closest("[data-rm-restore], [data-rm-restore-all]");
    if (back) {
      back.disabled = true;
      const paths = back.dataset.rmRestore ? [back.dataset.rmRestore]
        : ((await fetch("/api/photo/removed").then(r => r.json())).photos || []).map(p => p.path);
      await restore(paths);
      renderRemovedPhotos();
      return;
    }
    const v = e.target.closest("[data-pv-remove]");
    if (v) {
      const path = v.dataset.pvRemove;
      v.disabled = true;
      if (await removePhotos({ path }, `“${path.split("/").pop()}”`)) document.querySelector("#pv-close")?.click();
      v.disabled = false;
      return;
    }
    const f = e.target.closest("[data-rm-face]");
    if (f) {
      e.stopPropagation();
      f.disabled = true;
      await removePhotos({ faces: [+f.dataset.rmFace] }, "the photo this face is in");
      f.disabled = false;
      return;
    }
    const s = e.target.closest("#nm-sel-rmphoto");
    if (s && typeof selected !== "undefined" && selected.size) {
      const ids = [...selected];
      s.disabled = true;
      if (await removePhotos({ faces: ids }, ids.length === 1 ? "the photo this face is in" : `the photos these ${ids.length} faces are in`)) {
        selected.clear();
        if (typeof updateFloating === "function") updateFloating();
      }
      s.disabled = false;
    }
  }, true);
})();
