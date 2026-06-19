<script lang="ts">
  // A Mega-Man-stage-ish backdrop: vertical light pillars scrolling across at different
  // speeds/directions, overlapping (alpha) and bobbing. Pure CSS transforms/opacity → GPU.
  const palette = [
    "239,68,68", // vermelho
    "249,115,22", // laranja
    "153,27,27", // vermelho escuro
    "194,65,12", // laranja escuro
    "114,47,55", // vinho
    "226,114,91", // terracota
    "150,79,76", // marsala
  ];
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  const bars = Array.from({ length: 22 }, () => {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const dur = rnd(10, 38);
    return {
      w: rnd(5, 46),
      x0: dir > 0 ? -12 : 112,
      x1: dir > 0 ? 112 : -12,
      dur,
      delay: -rnd(0, dur),
      op: rnd(0.05, 0.17).toFixed(3),
      blur: (Math.random() < 0.45 ? rnd(0, 2.4) : 0).toFixed(2),
      bob: rnd(-38, 38).toFixed(0),
      bobDur: rnd(2.6, 6).toFixed(2),
      c: palette[Math.floor(Math.random() * palette.length)],
    };
  });
</script>

<div class="stage" aria-hidden="true">
  {#each bars as b, i (i)}
    <div
      class="track"
      style="--x0:{b.x0}vw; --x1:{b.x1}vw; --dur:{b.dur}s; --delay:{b.delay}s; width:{b.w}px; filter: blur({b.blur}px);"
    >
      <div
        class="bar"
        style="--c:{b.c}; --op:{b.op}; --bob:{b.bob}px; --bobDur:{b.bobDur}s;"
      ></div>
    </div>
  {/each}
</div>

<style>
  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .track {
    position: absolute;
    top: -5%;
    left: 0;
    height: 110%;
    transform: translateX(var(--x0));
    animation: passX var(--dur) linear var(--delay) infinite;
    will-change: transform;
  }
  .bar {
    width: 100%;
    height: 100%;
    background: linear-gradient(
      180deg,
      transparent 0%,
      rgba(var(--c), 0.9) 26%,
      rgba(var(--c), 0.9) 74%,
      transparent 100%
    );
    opacity: var(--op);
    animation: bobY var(--bobDur) ease-in-out infinite alternate;
    will-change: transform, opacity;
  }
  @keyframes passX {
    from {
      transform: translateX(var(--x0));
    }
    to {
      transform: translateX(var(--x1));
    }
  }
  @keyframes bobY {
    from {
      transform: translateY(0);
      opacity: var(--op);
    }
    to {
      transform: translateY(var(--bob));
      opacity: calc(var(--op) * 2.1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .track,
    .bar {
      animation: none;
    }
  }
</style>
