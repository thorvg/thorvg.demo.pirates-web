import ThorVG from '@thorvg/webcanvas';
import type { RendererType } from '@thorvg/webcanvas';
// The package `exports` map doesn't expose the wasm subpath, so reference the file directly.
import wasmUrl from '../node_modules/@thorvg/webcanvas/dist/thorvg.wasm?url';
import fontUrl from './assets/04B_30__.ttf?url';
import { ThorPirates, WIDTH, HEIGHT } from './pirates';

// ?renderer=<engine> selects the rendering backend. The default is `gl`.
function options(): RendererType {
  const engine = new URLSearchParams(location.search).get('renderer');
  if (engine === 'sw') return 'sw';
  if (engine === 'wg' && 'gpu' in navigator) return 'wg';
  return 'gl';
}

function fit(stage: HTMLElement) {
  const scale = Math.min(innerWidth / WIDTH, innerHeight / HEIGHT);
  stage.style.transform = `translate(${(innerWidth - WIDTH * scale) * 0.5}px, ${(innerHeight - HEIGHT * scale) * 0.5}px) scale(${scale})`;
}

async function main() {
  const status = document.getElementById('status')!;
  const stage = document.getElementById('stage')!;
  const engine = options();
  document.title = `ThorVG Pirate (${{ sw: 'CPU', gl: 'WebGL', wg: 'WebGPU' }[engine]})`;

  const [TVG, font] = await Promise.all([
    ThorVG.init({
      locateFile: () => wasmUrl,
      renderer: engine,
      onError: (error, context) => console.warn(`[thorvg] ${context.operation}:`, error.message),
    }),
    fetch(fontUrl).then((response) => response.arrayBuffer()),
  ]);

  const canvas = new TVG.Canvas('#canvas', { width: WIDTH, height: HEIGHT });
  const game = new ThorPirates(TVG, canvas, engine !== 'sw', new Uint8Array(font));
  game.content();
  if (import.meta.env.DEV) Object.assign(window, { game });  // console debugging handle
  canvas.update().render();
  status.remove();

  fit(stage);
  addEventListener('resize', () => fit(stage));

  addEventListener('keydown', (event) => {
    if (game.keydown(event.code)) event.preventDefault();
  });
  addEventListener('keyup', (event) => {
    if (game.keyup(event.code)) event.preventDefault();
  });
  addEventListener('blur', () => game.releaseKeys());

  // The game clock only advances while frames are delivered, so a hidden tab pauses the game.
  let elapsed = 0;
  let previous = performance.now();
  const frame = (now: number) => {
    elapsed += Math.min(now - previous, 100);
    previous = now;
    if (game.update(elapsed)) canvas.update().render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
  document.getElementById('status')!.textContent = `Failed to start: ${error?.message ?? error}`;
});
