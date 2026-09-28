// The 3D scene: one tin cup on a string, fireflies, dusk. Three.js draws, GSAP animates.
import gsap from "gsap";
import * as THREE from "three";

const COLOR = { enamel: 0xe2483d, tin: 0xc9ced6, tinInside: 0xe4e9f0, twine: 0xd8b27a, glow: 0xffe08a };
const CUP_BOTTOM = new THREE.Vector3(0, -0.7, 0); // in the cup's own space; the mouth is at +y

export type CupScene = ReturnType<typeof createScene>;

export function createScene(canvas: HTMLCanvasElement, reducedMotion: boolean) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x2a2448, 12, 40);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 8);

  scene.add(new THREE.HemisphereLight(0x8a8fd8, 0xe88a5a, 1.6));
  const sunset = new THREE.DirectionalLight(0xffc28a, 2.2);
  sunset.position.set(-4, 1, 5);
  scene.add(sunset);

  const cup = buildCup();
  scene.add(cup.group);
  const string = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ color: COLOR.twine, roughness: 0.9 }),
  );
  scene.add(string);
  const pulse = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 12, 12),
    new THREE.MeshBasicMaterial({ color: COLOR.glow }),
  );
  scene.add(pulse);
  const fireflies = buildFireflies(70);
  scene.add(fireflies);

  // Where the far end of the string goes: up out of frame on the landing, off to the horizon in a call.
  const farEnd = new THREE.Vector3(2.2, 9, 0);
  const travel = { t: -1 }; // position of the pulse along the string, 0 = far end, 1 = our cup
  let level = () => 0;
  let onCall = false;

  function layout() {
    const { clientWidth: width, clientHeight: height } = canvas;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (onCall) return;
    const narrow = camera.aspect < 0.9;
    cup.group.position.x = narrow ? 0 : 2.2;
    cup.group.position.y = narrow ? 1.4 : 0.2;
    farEnd.set(cup.group.position.x, 9, 0);
  }

  function drawString(time: number, loudness: number) {
    const start = CUP_BOTTOM.clone().applyMatrix4(cup.group.matrixWorld);
    const sag = new THREE.Vector3(0, onCall ? -1.2 : 0, 0);
    const points = [0, 0.25, 0.5, 0.75, 1].map((f, i) => {
      const point = start
        .clone()
        .lerp(farEnd, f)
        .addScaledVector(sag, Math.sin(f * Math.PI));
      const wave = Math.sin(time * 38 + i * 2.1) * loudness * 0.35 * Math.sin(f * Math.PI);
      return point.add(new THREE.Vector3(wave, wave * 0.6, 0));
    });
    const curve = new THREE.CatmullRomCurve3(points);
    string.geometry.dispose();
    string.geometry = new THREE.TubeGeometry(curve, 96, 0.014, 6);
    pulse.visible = travel.t >= 0;
    if (pulse.visible) pulse.position.copy(curve.getPoint(1 - travel.t));
  }

  renderer.setAnimationLoop((ms) => {
    const time = ms / 1000;
    const loudness = Math.min(level() * 6, 1);
    if (!onCall && !reducedMotion) cup.group.rotation.z = Math.sin(time * 1.1) * 0.06;
    cup.glow.intensity = 0.4 + loudness * 3;
    fireflies.rotation.y = reducedMotion ? 0 : time * 0.02;
    fireflies.material.opacity = reducedMotion ? 0.8 : 0.55 + Math.sin(time * 1.7) * 0.25;
    cup.group.updateMatrixWorld();
    drawString(time, reducedMotion ? loudness * 0.3 : loudness);
    renderer.render(scene, camera);
  });

  new ResizeObserver(layout).observe(canvas);
  layout();
  cup.group.rotation.x = Math.PI - 0.3; // hanging mouth-down, tipped so you glimpse the tin inside
  if (!reducedMotion) gsap.from(cup.group.position, { y: 7, duration: 2.2, ease: "elastic.out(1, 0.35)" });

  return {
    /** Anything returning a 0–1 loudness drives the string's vibration and the glow in the cup. */
    listenTo(source: () => number) {
      level = source;
    },

    /** The cup swings round so its mouth faces you; the string runs off to the horizon. */
    pickUp() {
      onCall = true;
      gsap.killTweensOf(cup.group.position); // the drop-in may still be bouncing
      const duration = reducedMotion ? 0 : 1.6;
      gsap.to(cup.group.position, { x: 0, y: -1.45, z: 3.9, duration, ease: "power3.inOut" });
      gsap.to(cup.group.rotation, { x: 1.38, z: 0, duration, ease: "power3.inOut" });
      gsap.to(farEnd, { x: 9, y: 4, z: -30, duration, ease: "power2.inOut" });
    },

    /** The cup sinks out of view; pickUp brings it back. */
    putDown() {
      gsap.killTweensOf(cup.group.position);
      gsap.to(cup.group.position, { y: -4.5, duration: reducedMotion ? 0 : 1.1, ease: "power2.in" });
    },

    /** Send a glowing pulse down the string toward us: words are on their way. */
    sendPulse() {
      gsap.fromTo(
        travel,
        { t: 0 },
        { t: 1, duration: 1.4, ease: "power1.in", onComplete: () => (travel.t = -1) },
      );
    },
  };
}

function buildCup() {
  const group = new THREE.Group();
  const profile = [
    [0, -0.7],
    [0.55, -0.7],
    [0.58, -0.66],
    [0.72, 0.68],
    [0.74, 0.72],
  ].map(([radius, y]) => new THREE.Vector2(radius, y));
  // Enamel outside, bare tin inside: one shape, two materials, one per face side.
  const shape = new THREE.LatheGeometry(profile, 64);
  const enamel = new THREE.Mesh(
    shape,
    new THREE.MeshStandardMaterial({
      color: COLOR.enamel,
      metalness: 0.35,
      roughness: 0.4,
      side: THREE.FrontSide,
    }),
  );
  const tin = new THREE.Mesh(
    shape,
    new THREE.MeshStandardMaterial({
      color: COLOR.tinInside,
      metalness: 0.3,
      roughness: 0.5,
      side: THREE.BackSide,
    }),
  );
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.735, 0.03, 12, 64),
    new THREE.MeshStandardMaterial({ color: COLOR.tin, metalness: 0.9, roughness: 0.25 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.72;
  const seam = rim.clone(); // the rolled seam near the base
  seam.scale.setScalar(0.785);
  seam.position.y = -0.6;
  const knot = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 16),
    new THREE.MeshBasicMaterial({ color: COLOR.glow }),
  );
  knot.position.set(0, -0.66, 0);
  const glow = new THREE.PointLight(COLOR.glow, 0.4, 2.5);
  glow.position.set(0, -0.4, 0);
  group.add(enamel, tin, rim, seam, knot, glow);
  return { group, glow };
}

function buildFireflies(count: number) {
  const positions = Float32Array.from({ length: count * 3 }, (_, i) =>
    i % 3 === 1 ? (Math.random() - 0.3) * 8 : (Math.random() - 0.5) * 22,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: COLOR.glow,
    map: softDot(),
    size: 0.16,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Points(geometry, material);
}

/** A soft round glow drawn once on a canvas, so fireflies aren't square pixels. */
function softDot() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.6)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}
