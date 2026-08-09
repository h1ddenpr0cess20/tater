import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';

import { ENERGY_GAIN, MOODS } from '../../src/client/tater/moods.js';
import { approach, spring } from '../../src/client/tater/motion.js';
import { hash3, vnoise } from '../../src/client/tater/noise.js';
import { EYE_DIRS, HALF, bumps, surf, surfNormal } from '../../src/client/tater/shape.js';
import { createTaterBuddy } from '../../src/client/tater/index.js';

describe('MOODS', () => {
  const CHANNELS = ['jitter', 'lean', 'rock', 'rockSpeed', 'step', 'spin', 'squash', 'stand', 'fidget'];

  it('covers the four conversational states', () => {
    assert.deepEqual(Object.keys(MOODS).sort(), ['idle', 'listening', 'speaking', 'thinking']);
  });

  it('gives every state every channel', () => {
    for (const [name, mood] of Object.entries(MOODS)) {
      assert.deepEqual(Object.keys(mood).sort(), [...CHANNELS].sort(), `${name} is missing a channel`);
      for (const [channel, value] of Object.entries(mood)) {
        assert.equal(typeof value, 'number', `${name}.${channel}`);
        assert.ok(Number.isFinite(value), `${name}.${channel} is not finite`);
      }
    }
  });

  it('names only channels that exist when energy pushes them', () => {
    for (const channel of Object.keys(ENERGY_GAIN)) {
      assert.ok(channel in MOODS.idle, `ENERGY_GAIN.${channel} has no matching mood channel`);
    }
  });

  it('spins for thinking and nothing else, which is the pose that reads', () => {
    assert.ok(MOODS.thinking.spin > 0);
    for (const name of ['idle', 'listening', 'speaking']) {
      assert.equal(MOODS[name].spin, 0, `${name} would spin`);
    }
  });

  it('keeps listening calmer than speaking, and walks only while talking', () => {
    assert.ok(MOODS.listening.jitter < MOODS.speaking.jitter);
    assert.ok(MOODS.listening.squash < MOODS.speaking.squash);
    assert.ok(MOODS.speaking.step > 0);
    assert.equal(MOODS.idle.step, 0);
  });

  it('stands for every state but thinking, which is the one that lies down', () => {
    for (const name of ['idle', 'listening', 'speaking']) {
      assert.equal(MOODS[name].stand, 1, `${name} would not be standing`);
    }
    assert.equal(MOODS.thinking.stand, 0);
  });

  it('leaves the states that should hold still with nothing for energy to scale', () => {
    assert.equal(MOODS.thinking.squash, 0);
    assert.equal(MOODS.idle.squash, 0);
  });
});

describe('motion', () => {
  describe('spring', () => {
    it('settles on its target from either side', () => {
      for (const from of [-2, 0, 5]) {
        const s = { p: from, v: 0 };
        for (let i = 0; i < 2000; i++) spring(s, 175, 10.5, 1 / 60, 1);
        assert.ok(Math.abs(s.p - 1) < 1e-6, `from ${from} settled at ${s.p}`);
        assert.ok(Math.abs(s.v) < 1e-6);
      }
    });

    it('overshoots before it settles — that is the whole point of a spring', () => {
      const s = { p: 0, v: 0 };
      let peak = 0;
      for (let i = 0; i < 240; i++) peak = Math.max(peak, spring(s, 175, 6, 1 / 60, 1));
      assert.ok(peak > 1, `never overshot, peaked at ${peak}`);
    });

    it('stays finite at the longest frame the loop will hand it', () => {
      const s = { p: 0, v: 0 };
      for (let i = 0; i < 500; i++) spring(s, 175, 10.5, 0.05, 1);
      assert.ok(Number.isFinite(s.p) && Number.isFinite(s.v));
      assert.ok(Math.abs(s.p - 1) < 1e-3);
    });

    it('returns the position it just wrote, so a caller can read it inline', () => {
      const s = { p: 0, v: 0 };
      assert.equal(spring(s, 68, 6.2, 1 / 60, 1), s.p);
    });
  });

  describe('approach', () => {
    it('closes a fixed fraction of the gap per second', () => {
      assert.equal(approach(0, 1, 2, 0.25), 0.5);
    });

    it('lands exactly on target rather than overshooting on a long frame', () => {
      assert.equal(approach(0, 1, 10, 1), 1);
      assert.equal(approach(5, -3, 40, 0.5), -3);
    });

    it('is a no-op when it is already there', () => {
      assert.equal(approach(0.4, 0.4, 3.2, 1 / 60), 0.4);
    });
  });
});

describe('noise', () => {
  it('stays inside the range the amplitudes are written against', () => {
    for (let i = 0; i < 5000; i++) {
      const v = vnoise(i * 0.37, i * -0.11 + 4, i * 0.73 - 9);
      assert.ok(v >= -1 && v <= 1, `${v} escaped -1..1`);
    }
  });

  it('is deterministic — the same potato on every load', () => {
    assert.equal(vnoise(1.25, -3.5, 8.75), vnoise(1.25, -3.5, 8.75));
    assert.equal(hash3(7, -2, 91), hash3(7, -2, 91));
  });

  it('is smooth: neighbouring samples do not jump', () => {
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const a = vnoise(i * 0.01, 0.5, -0.25);
      const b = vnoise(i * 0.01 + 0.01, 0.5, -0.25);
      worst = Math.max(worst, Math.abs(a - b));
    }
    assert.ok(worst < 0.15, `jumped ${worst} between adjacent samples`);
  });

  it('lands on the lattice value at whole coordinates', () => {
    assert.ok(Math.abs(vnoise(3, 4, 5) - (hash3(3, 4, 5) * 2 - 1)) < 1e-12);
  });
});

describe('shape', () => {
  const directions = () => {
    const out = [];
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < 24; j++) {
        const theta = (i + 0.5) / 24 * Math.PI;
        const phi = (j / 24) * Math.PI * 2;
        out.push([
          Math.cos(theta),
          Math.sin(theta) * Math.cos(phi),
          Math.sin(theta) * Math.sin(phi),
        ]);
      }
    }
    return out;
  };

  const extents = () => {
    const e = { x: 0, y: 0, z: 0 };
    for (const d of directions()) {
      const p = surf(...d);
      e.x = Math.max(e.x, Math.abs(p[0]));
      e.y = Math.max(e.y, Math.abs(p[1]));
      e.z = Math.max(e.z, Math.abs(p[2]));
    }
    return e;
  };

  it('is authored lying along x — longer that way than it is thick', () => {
    const e = extents();
    assert.ok(e.x > e.y, `${e.x} is not longer than ${e.y}`);
    assert.ok(e.x > e.z, `${e.x} is not longer than ${e.z}`);
  });

  it('is roughly round in cross-section, not a plank', () => {
    const e = extents();
    assert.ok(e.y / e.z > 0.7 && e.y / e.z < 1.4, `cross-section ${e.y}×${e.z} is not a tuber`);
  });

  it('stays near the half-extents it is scaled to — the lumps ride the shape, not the other way round', () => {
    const e = extents();
    for (const axis of ['x', 'y', 'z']) {
      const ratio = e[axis] / HALF[axis];
      assert.ok(ratio > 0.85 && ratio < 1.3, `${axis} came out ${ratio}× its half-extent`);
    }
  });

  it('is lumpy — a smooth ellipsoid would read as a stone', () => {
    let bumpiest = 0;
    for (const d of directions()) bumpiest = Math.max(bumpiest, Math.abs(bumps(...d)));
    assert.ok(bumpiest > 0.05, `the surface only varies by ${bumpiest}`);
  });

  it('writes into the array it is handed and gives it back', () => {
    const out = [0, 0, 0];
    assert.equal(surf(0.5, 0.5, 0.7071, out), out);
    assert.ok(out.every(Number.isFinite));
  });

  it('is finite at the ends, where the profile pinches to nothing', () => {
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
      assert.ok(surf(...d).every(Number.isFinite), `${d} blew up`);
    }
  });

  it('is deterministic — no randomness to make Tater differ per load', () => {
    assert.deepEqual(surf(0.3, -0.6, 0.74), surf(0.3, -0.6, 0.74));
  });

  describe('surfNormal', () => {
    it('is a unit vector', () => {
      for (const d of EYE_DIRS) {
        const n = surfNormal(...d);
        assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6, `${d} gave a normal of length ${Math.hypot(...n)}`);
      }
    });

    it('points outward, so the eyes sink in rather than float off', () => {
      for (const d of EYE_DIRS) {
        const n = surfNormal(...d);
        const dot = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
        assert.ok(dot > 0, `${d} gave an inward normal`);
      }
    });
  });

  it('places every eye on a distinct unit direction', () => {
    assert.equal(new Set(EYE_DIRS.map(String)).size, EYE_DIRS.length);
    for (const d of EYE_DIRS) {
      assert.ok(Math.abs(Math.hypot(...d) - 1) < 0.02, `${d} is not a unit direction`);
    }
  });
});

describe('createTaterBuddy', () => {
  const stubStage = () => ({ _scene: {}, _renderer: null, setObject() {} });

  it('ignores a state that is not one of the four', () => {
    const tater = createTaterBuddy({ stage: stubStage(), THREE });
    tater.setState('speaking');

    for (const junk of ['nonsense', 'constructor', '__proto__', 'toString']) {
      tater.setState(junk);
      assert.equal(tater.state, 'speaking', `${junk} was taken for a mood`);
    }
  });

  it('clamps what it is handed, so a bad level cannot escape the range', () => {
    const tater = createTaterBuddy({ stage: stubStage(), THREE });
    assert.doesNotThrow(() => {
      tater.setLevel(4);
      tater.setLevel(-1);
      tater.pulse(9);
      tater.pulse(-3);
    });
  });

  it('hands the stage a named object, since the exporter writes those names out', () => {
    let object = null;
    createTaterBuddy({ stage: { _scene: {}, _renderer: null, setObject: (o) => { object = o; } }, THREE });
    assert.equal(object.name, 'tater');
    assert.ok(object.getObjectByName('tuber'), 'no tuber under the group');
    assert.ok(object.getObjectByName('spinner').getObjectByName('body'));
    assert.ok(object.getObjectByName('body').getObjectByName('stance'));
  });

  it('stands on his end, from the first frame — the camera frames what it is handed', () => {
    let object = null;
    createTaterBuddy({ stage: { _scene: {}, _renderer: null, setObject: (o) => { object = o; } }, THREE });

    const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
    assert.ok(size.y > size.x * 1.3, `${size.y} tall is not standing over ${size.x} wide`);
    assert.ok(size.y > size.z * 1.3, `${size.y} tall is not standing over ${size.z} deep`);
  });

  it('gives every mesh its own name — the OBJ exporter writes them out', () => {
    let object = null;
    createTaterBuddy({ stage: { _scene: {}, _renderer: null, setObject: (o) => { object = o; } }, THREE });

    const names = [];
    object.traverse((o) => { if (o.isMesh) names.push(o.name); });
    assert.ok(names.length > EYE_DIRS.length, 'the eyes did not make it onto the body');
    assert.equal(new Set(names).size, names.length, 'two meshes share a name');
    assert.ok(names.every(Boolean), 'a mesh went out unnamed');
  });
});
