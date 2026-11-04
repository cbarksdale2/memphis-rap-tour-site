// Admin helpers. Photos are shrunk to at most 2000px and re-encoded (WebP, or JPEG where the browser
// can't make WebP) before upload. That keeps storage small and removes location data from phone photos.
// iPhone HEIC photos: Safari decodes them, so they are converted here too.
(function () {
  var MAX = 2000;

  function suggestAlt(name) {
    var base = String(name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_+\-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!base || /^(img|dsc|image|photo|pxl)\s?\d+/i.test(base) || /^\d+$/.test(base)) return "Memphis Rap Tour photo: ";
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  function toBlob(canvas, type, q) {
    return new Promise(function (res) { canvas.toBlob(res, type, q); });
  }

  function load(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }

  async function shrink(file) {
    var loaded = await load(file);
    var img = loaded.img;
    var scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(loaded.url);
    var blob = await toBlob(canvas, "image/webp", 0.82);
    var ext = "webp";
    if (!blob || blob.type !== "image/webp") { blob = await toBlob(canvas, "image/jpeg", 0.85); ext = "jpg"; }
    var name = (file.name || "photo").replace(/\.[a-z0-9]+$/i, "") + "." + ext;
    return { file: new File([blob], name, { type: blob.type }), w: w, h: h };
  }

  document.querySelectorAll("input[type=file][data-resize]").forEach(function (input) {
    input.addEventListener("change", async function () {
      var form = input.form;
      var status = form && form.querySelector(".resize-status");
      var f = input.files && input.files[0];
      if (!f) return;
      var altId = input.getAttribute("data-alt-target");
      var alt = altId && document.getElementById(altId);
      if (alt && !alt.value.trim()) {
        alt.value = suggestAlt(f.name);
        if (status) status.textContent = "Suggested description filled in. Change it to say what's in the photo.";
      }
      var btn = form && form.querySelector("button[type=submit]");
      try {
        if (btn) btn.disabled = true;
        if (status) status.textContent = "Getting the photo ready…";
        var out = await shrink(f);
        var dt = new DataTransfer();
        dt.items.add(out.file);
        input.files = dt.files;
        if (status) status.textContent = "Ready: " + out.w + " × " + out.h + " pixels, " + Math.round(out.file.size / 1024) + " KB." + (alt ? " Check the description, then tap Upload." : "");
      } catch (e) {
        if (status) status.textContent = "This browser couldn't open that photo. Try a JPEG or PNG, or use Safari on the iPhone.";
        input.value = "";
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  });
})();
