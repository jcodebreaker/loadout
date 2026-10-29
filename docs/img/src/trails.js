// The faint background trails from the review page, drawn once.
function drawTrails(seed = 7, count = 14, top = 0.35) {
  const cv = document.getElementById("trails"), ctx = cv.getContext("2d"), dpr = devicePixelRatio || 1;
  const w = innerWidth, h = innerHeight;
  cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--trail").trim();
  ctx.lineWidth = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < count; k++) {
    let x = -40, y = h * (top + rnd() * (1 - top)), a = (rnd() - 0.5) * 0.6;
    ctx.globalAlpha = 0.25 + rnd() * 0.35;
    ctx.beginPath(); ctx.moveTo(x, y);
    while (x < w + 40) { a += (rnd() - 0.5) * 0.35; a = Math.max(-0.9, Math.min(0.9, a)); x += 14; y += Math.sin(a) * 10; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
