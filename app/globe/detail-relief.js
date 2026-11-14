/* Natural Earth Gray Earth, 1:10m. Equirectangular tiles, 60 pixels per degree. */
(() => {
  'use strict';
  const directory = new URL('../assets/terrain/', document.currentScript.src);
  const degrees = 15, columns = 24, rows = 12;
  function keyAt(lon, lat) {
    const col = Math.min(columns - 1, Math.max(0, Math.floor((lon + 180) / degrees)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / degrees)));
    return row * columns + col;
  }

  function create(onReady) {
    const tiles = new Array(columns * rows);
    const pending = new Set(), failed = new Map();
    let wanted = new Set(), signature = '', active = false;

    function load(key) {
      const col = key % columns, row = Math.floor(key / columns);
      const image = new Image();
      pending.add(key);
      image.onload = () => {
        try {
          if (wanted.has(key)) {
            const canvas = document.createElement('canvas');
            const width = canvas.width = image.naturalWidth;
            const height = canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            context.drawImage(image, 0, 0);
            tiles[key] = {width, height, degrees, west: -180 + col * degrees,
              north: 90 - row * degrees, data: context.getImageData(0, 0, width, height).data};
            onReady();
          }
        } catch {
          failed.set(key, Date.now());
        } finally {
          pending.delete(key);
          pump();
        }
      };
      image.onerror = () => {
        failed.set(key, Date.now());
        pending.delete(key);
        pump();
      };
      image.src = new URL(col + '-' + row + '.webp', directory).href;
    }

    function pump() {
      for (const key of wanted) {
        if (pending.size >= 3) break;
        if (tiles[key] || pending.has(key) || Date.now() - (failed.get(key) || 0) < 30000) continue;
        load(key);
      }
    }

    function update(cam, moving) {
      active = cam.w > 80 && cam.radius >= Math.max(820, cam.w * 1.3);
      if (moving) return;
      const next = active ? [cam.w, cam.h, cam.cx, cam.cy, cam.radius, cam.lon, cam.sin].join('|') : '';
      if (signature === next) return;
      signature = next;
      const distance = new Map();
      if (active) {
        // Invert the same orthographic projection as the globe. This includes
        // the far side of the date line and accounts for the offset camera.
        const radToDeg = 180 / Math.PI;
        for (let y = 0; y <= 12; y++) {
          const py = (cam.cy - cam.h * y / 12) / cam.radius;
          for (let x = 0; x <= 18; x++) {
            const px = (cam.w * x / 18 - cam.cx) / cam.radius;
            const zz = 1 - px * px - py * py;
            if (zz < 0) continue;
            const z = Math.sqrt(zz);
            const lat = Math.asin(Math.max(-1, Math.min(1, py * cam.cos + z * cam.sin))) * radToDeg;
            const lon = (cam.lon + Math.atan2(px, z * cam.cos - py * cam.sin) * radToDeg + 540) % 360 - 180;
            const key = keyAt(lon, lat);
            const priority = (x / 18 - .5) ** 2 + (y / 12 - .5) ** 2;
            distance.set(key, Math.min(priority, distance.get(key) ?? Infinity));
          }
        }
      }
      wanted = new Set([...distance.keys()].sort((a, b) => distance.get(a) - distance.get(b)).slice(0, 18));
      for (let i = 0; i < tiles.length; i++) {
        if (tiles[i] && !wanted.has(i)) tiles[i] = undefined;
      }
      pump();
    }
    return {update, get active() { return active; }, tileAt(lon, lat) { return tiles[keyAt(lon, lat)]; }};
  }
  window.PoseidonDetailRelief = {create};
})();
