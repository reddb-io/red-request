<script lang="ts">
  // Mega-Man-stage backdrop on one canvas: vertical light pillars scrolling at varied
  // speeds and directions, bobbing and pulsing. One rAF loop, no CSS blur, so it is cheap.
  // Pauses when the tab is hidden and honors prefers-reduced-motion.
  import { onMount } from "svelte";

  let canvas: HTMLCanvasElement;

  const palette = [
    "239,68,68", // red
    "249,115,22", // orange
    "153,27,27", // dark red
    "194,65,12", // dark orange
    "114,47,55", // wine
    "226,114,91", // terracotta
    "150,79,76", // marsala
    "220,20,60", // carmine
    "227,66,52", // vermilion
    "128,0,32", // burgundy
    "128,0,0", // garnet
    "183,65,14", // rust
    "240,128,128", // coral
    "192,64,0", // mahogany
    "74,4,4", // oxblood
    "178,34,34", // brick
  ];

  onMount(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 1;
    let h = 1;

    function resize() {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const bars = Array.from({ length: 16 }, () => {
      const dir = Math.random() < 0.5 ? 1 : -1;
      // mostly thin pillars, ~30% noticeably thicker for variety
      const thick = Math.random() < 0.3;
      return {
        x: rnd(-0.1, 1.1) * w,
        w: thick ? rnd(48, 96) : rnd(5, 42),
        speed: dir * rnd(8, 58), // px/s
        c: palette[Math.floor(Math.random() * palette.length)]!,
        alpha: rnd(0.05, 0.18),
        phase: rnd(0, Math.PI * 2),
        amp: rnd(8, 38), // vertical bob px
        freq: rnd(0.2, 0.7),
      };
    });

    function draw(now: number, dt: number) {
      ctx!.clearRect(0, 0, w, h);
      const ts = now / 1000;
      for (const b of bars) {
        b.x += b.speed * dt;
        if (b.x > w + 60) b.x = -60;
        else if (b.x < -60) b.x = w + 60;
        const yoff = Math.sin(ts * b.freq + b.phase) * b.amp;
        const a = b.alpha * (1 + 0.7 * Math.sin(ts * b.freq * 1.3 + b.phase));
        const top = -60 + yoff;
        const g = ctx!.createLinearGradient(0, top, 0, h + 60 + yoff);
        g.addColorStop(0, `rgba(${b.c},0)`);
        g.addColorStop(0.28, `rgba(${b.c},${a})`);
        g.addColorStop(0.72, `rgba(${b.c},${a})`);
        g.addColorStop(1, `rgba(${b.c},0)`);
        ctx!.fillStyle = g;
        ctx!.fillRect(b.x, top, b.w, h + 120);
      }
    }

    let raf = 0;
    let last = performance.now();
    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(now, dt);
      raf = requestAnimationFrame(frame);
    }

    function start() {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      cancelAnimationFrame(raf);
    }

    if (reduced) {
      draw(performance.now(), 0); // static single frame
    } else {
      start();
    }

    const onVis = () => {
      if (reduced) return;
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  });
</script>

<!-- .stage lives in app.css (global) — see note there about Tailwind v4 + Svelte styles. -->
<canvas bind:this={canvas} class="stage" aria-hidden="true"></canvas>
