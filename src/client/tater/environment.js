/** Even wash rather than a dark floor: he turns, and the far side has to hold. */
export function buildEnvironment({ stage, THREE }) {
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, '#e8dcc9'); g.addColorStop(0.5, '#a89f92');
    g.addColorStop(0.56, '#7c766d'); g.addColorStop(1, '#615c55');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = 'rgba(255,247,232,0.95)'; ctx.beginPath();
    ctx.ellipse(20, 6, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.Texture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(stage._renderer);
    stage._scene.environment = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose(); tex.dispose();

    // A directional key is what makes an unlit side, and he turns through every
    // facing. So the key drops to the little that shape needs and the rest of
    // the light goes omnidirectional — ambient dominant, plus a counter on the
    // corner the stage leaves to the wash. No facing can fall far behind the
    // one pointed at the key, which is the dark back.
    const hemi = [];
    const fills = [];
    stage._scene.traverse((o) => {
      if (o.isHemisphereLight) hemi.push(o);
      else if (o.isDirectionalLight && o !== stage._key) fills.push(o);
    });
    for (const light of hemi) light.intensity = 0.45;
    for (const light of fills) light.intensity = 0.25;
    if (stage._key) stage._key.intensity = 0.35;

    const ambient = new THREE.AmbientLight(0xfff3e4, 0.55);
    ambient.name = 'tater-ambient';
    stage._scene.add(ambient);

    const counter = new THREE.DirectionalLight(0xffeeda, 0.25);
    counter.name = 'tater-counter-fill';
    counter.position.set(-5, 2.5, 4);
    stage._scene.add(counter);
  } catch {
  }
}

/**
 * A lumpy body throws a shadow that crawls as it turns, so it goes without one.
 * After `setObject` — that is where the stage sets the flags.
 */
export function dropShadows({ stage, object }) {
  // At the renderer, so no per-mesh flag can leave one behind: the map is
  // neither rendered nor sampled. The materials have already compiled with the
  // shadow path in them, so they have to be told to build again — skip that
  // and the shader keeps sampling a map that is no longer there, which renders
  // everything the key lights black.
  if (stage._renderer) stage._renderer.shadowMap.enabled = false;

  object.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
      if (material) material.needsUpdate = true;
    }
  });

  if (stage._ground) stage._ground.visible = false;
}
