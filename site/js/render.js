// The WebGL2 renderer. Each tile is a quad sampling its two textures
// (tileformat.js); the colour mode, highlighting and hatching are
// uniforms, so switching any of them costs no tile rebuild.
//
// Tile rectangles are computed in JS doubles and handed over as clip
// coordinates, so no world coordinate large enough to lose float32
// precision ever reaches the GPU.

import { LOD_COARSE } from "./config.js";
import { bytePalette } from "./colors.js";
import { PATH_TABLE_WIDTH } from "./tileformat.js";
import { Mode } from "./url.js";

export const MODE_CODES = Object.freeze({
  [Mode.BYTES]: 0,
  [Mode.CLASSES]: 1,
  [Mode.ENTROPY]: 2,
  [Mode.PACKAGE]: 3,
});

const VERTEX = `#version 300 es
in vec2 a_corner;
uniform vec4 u_rect;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  v_uv = mix(u_uv.xy, u_uv.zw, a_corner);
  gl_Position = vec4(mix(u_rect.xy, u_rect.zw, a_corner), 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform sampler2D u_data;
uniform usampler2D u_ids;
uniform sampler2D u_paths;
uniform sampler2D u_palette;
uniform int u_mode;
uniform int u_lod;
uniform uint u_hovered;
uniform uint u_selected;
uniform uint u_hoveredFile;
uniform vec3 u_background;
uniform float u_dpr;
uniform float u_texelPx;

in vec2 v_uv;
out vec4 outColor;

const uint NO_PATH = 0xffffffffu;
const uint HAS_BYTES = 0x80000000u;
const uint FILE_MASK = 0x7fffffffu;
const uint TABLE_WIDTH = ${PATH_TABLE_WIDTH}u;

const int MODE_BYTES = 0;
const int MODE_ENTROPY = 2;
const int MODE_PACKAGE = 3;

const uint STATE_LOCAL = 4u;
const uint STATE_FAILED = 8u;
const uint STATE_LOADING = 16u;

const vec3 ZERO_COLOR = vec3(0.02, 0.02, 0.03);
const vec3 CONTROL_COLOR = vec3(0.20, 0.68, 0.35);
const vec3 ASCII_COLOR = vec3(0.25, 0.50, 0.95);
const vec3 HIGH_COLOR = vec3(0.92, 0.35, 0.20);

// Low entropy deep blue, high entropy pale yellow.
vec3 entropyRamp(float t) {
  vec3 c0 = vec3(0.04, 0.03, 0.16);
  vec3 c1 = vec3(0.30, 0.08, 0.48);
  vec3 c2 = vec3(0.74, 0.22, 0.38);
  vec3 c3 = vec3(0.97, 0.55, 0.14);
  vec3 c4 = vec3(0.99, 0.95, 0.60);
  float x = clamp(t, 0.0, 1.0) * 4.0;
  if (x < 1.0) return mix(c0, c1, x);
  if (x < 2.0) return mix(c1, c2, x - 1.0);
  if (x < 3.0) return mix(c2, c3, x - 2.0);
  return mix(c3, c4, x - 3.0);
}

vec3 classColor(uint b) {
  if (b == 0u) return ZERO_COLOR;
  if (b >= 128u) return HIGH_COLOR;
  if ((b >= 32u && b <= 126u) || b == 9u || b == 10u || b == 13u) return ASCII_COLOR;
  return CONTROL_COLOR;
}

// 1.0 on the stripes of a diagonal hatch measured in CSS pixels, so the
// pattern keeps its size at every zoom.
float hatch(float period, float width, bool rising) {
  vec2 p = gl_FragCoord.xy / u_dpr;
  float s = rising ? p.x + p.y : p.x - p.y;
  return step(mod(s, period), width);
}

uvec2 idsAt(ivec2 t) {
  return texelFetch(u_ids, clamp(t, ivec2(0), ivec2(255)), 0).rg;
}

// Whether a neighbour belongs to another path or, when asked, another file.
bool differs(uvec2 here, uvec2 there, bool files) {
  if (there.r == NO_PATH) return false;
  if (here.r != there.r) return true;
  return files && (here.g & FILE_MASK) != (there.g & FILE_MASK);
}

void main() {
  ivec2 t = clamp(ivec2(floor(v_uv)), ivec2(0), ivec2(255));
  uvec2 here = idsAt(t);
  uint id = here.r;
  if (id == NO_PATH) {
    outColor = vec4(u_background, 1.0);
    return;
  }

  vec4 path = texelFetch(u_paths, ivec2(int(id % TABLE_WIDTH), int(id / TABLE_WIDTH)), 0);
  vec3 pkg = path.rgb;
  uint state = uint(path.a * 255.0 + 0.5);
  bool hasBytes = (here.g & HAS_BYTES) != 0u;
  uint file = here.g & FILE_MASK;
  vec4 d = texelFetch(u_data, t, 0);

  vec3 color;
  if (!hasBytes) {
    // No bytes yet: the package colour, muted and hatched by state.
    float gray = dot(pkg, vec3(0.299, 0.587, 0.114));
    vec3 muted = u_mode == MODE_PACKAGE ? pkg : mix(vec3(gray), pkg, 0.45);
    if ((state & STATE_FAILED) != 0u) {
      color = mix(muted * 0.6, vec3(0.86, 0.22, 0.22), hatch(8.0, 3.0, true));
    } else if ((state & STATE_LOCAL) != 0u) {
      color = mix(vec3(0.40), vec3(0.55), hatch(8.0, 2.0, true));
    } else if ((state & STATE_LOADING) != 0u) {
      color = mix(muted * 0.75, pkg, hatch(6.0, 3.0, false));
    } else {
      color = mix(muted, muted * 0.78, hatch(8.0, 2.0, true));
    }
  } else if (u_mode == MODE_PACKAGE) {
    color = pkg * (0.65 + 0.5 * d.a);
  } else if (u_mode == MODE_ENTROPY) {
    color = entropyRamp(d.a);
  } else if (u_lod == 0) {
    uint b = uint(d.r * 255.0 + 0.5);
    color = u_mode == MODE_BYTES
      ? texelFetch(u_palette, ivec2(int(b), 0), 0).rgb
      : classColor(b);
  } else {
    float control = max(0.0, 1.0 - d.r - d.g - d.b);
    color = d.r * ZERO_COLOR + d.g * ASCII_COLOR + d.b * HIGH_COLOR + control * CONTROL_COLOR;
  }

  // Outlines where the path changes, and at deep zoom where the file does.
  if (u_texelPx >= 3.0) {
    vec2 f = fract(v_uv) * u_texelPx;
    float edge = u_dpr;
    bool files = u_texelPx >= 8.0;
    bool line =
      (f.x < edge && differs(here, idsAt(t + ivec2(-1, 0)), files)) ||
      (f.x > u_texelPx - edge && differs(here, idsAt(t + ivec2(1, 0)), files)) ||
      (f.y < edge && differs(here, idsAt(t + ivec2(0, -1)), files)) ||
      (f.y > u_texelPx - edge && differs(here, idsAt(t + ivec2(0, 1)), files));
    if (line) color *= 0.55;
  }

  // Highlighting: the hovered path, and the pinned one, stay lit.
  if (u_hovered != NO_PATH && id != u_hovered && id != u_selected) {
    color *= 0.42;
  } else if (u_hovered == NO_PATH && u_selected != NO_PATH && id != u_selected) {
    color *= 0.7;
  }
  if (u_hoveredFile != 0u && id == u_hovered && file == u_hoveredFile) {
    color = mix(color, vec3(1.0), 0.22);
  }

  outColor = vec4(color, 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

const UNIFORMS = [
  "u_rect",
  "u_uv",
  "u_data",
  "u_ids",
  "u_paths",
  "u_palette",
  "u_mode",
  "u_lod",
  "u_hovered",
  "u_selected",
  "u_hoveredFile",
  "u_background",
  "u_dpr",
  "u_texelPx",
];

const Unit = Object.freeze({ DATA: 0, IDS: 1, PATHS: 2, PALETTE: 3 });

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (gl === null) {
      throw new Error("this browser does not offer WebGL2");
    }
    this.gl = gl;
    this.canvas = canvas;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`shader link: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.u = Object.fromEntries(
      UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
    );

    // One unit quad, drawn as a strip.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const corner = gl.getAttribLocation(program, "a_corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.paths = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 1, 1, new Uint8Array(4));
    this.palette = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 256, 1, bytePalette());
  }

  texture(internal, format, type, width, height, data) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    return texture;
  }

  uploadTile(data, ids, size) {
    const gl = this.gl;
    return {
      data: this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, size, size, data),
      ids: this.texture(gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT, size, size, ids),
    };
  }

  deleteTile(textures) {
    this.gl.deleteTexture(textures.data);
    this.gl.deleteTexture(textures.ids);
  }

  setPathTable(bytes, rows) {
    const gl = this.gl;
    gl.deleteTexture(this.paths);
    this.paths = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, PATH_TABLE_WIDTH, rows, bytes);
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // Draw a list of { textures, k, rect: [x0, y0, x1, y1] device pixels,
  // uv: [u0, v0, u1, v1] texels }.
  draw(items, view) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    const [r, g, b] = view.background;
    gl.viewport(0, 0, width, height);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const u = this.u;
    gl.uniform1i(u.u_data, Unit.DATA);
    gl.uniform1i(u.u_ids, Unit.IDS);
    gl.uniform1i(u.u_paths, Unit.PATHS);
    gl.uniform1i(u.u_palette, Unit.PALETTE);
    gl.uniform1i(u.u_mode, MODE_CODES[view.mode]);
    gl.uniform1ui(u.u_hovered, view.hovered);
    gl.uniform1ui(u.u_selected, view.selected);
    gl.uniform1ui(u.u_hoveredFile, view.hoveredFile);
    gl.uniform3f(u.u_background, r, g, b);
    gl.uniform1f(u.u_dpr, view.dpr);

    gl.activeTexture(gl.TEXTURE0 + Unit.PATHS);
    gl.bindTexture(gl.TEXTURE_2D, this.paths);
    gl.activeTexture(gl.TEXTURE0 + Unit.PALETTE);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);

    for (const item of items) {
      const [x0, y0, x1, y1] = item.rect;
      const [u0, v0, u1, v1] = item.uv;
      gl.uniform4f(
        u.u_rect,
        (x0 / width) * 2 - 1,
        1 - (y0 / height) * 2,
        (x1 / width) * 2 - 1,
        1 - (y1 / height) * 2,
      );
      gl.uniform4f(u.u_uv, u0, v0, u1, v1);
      gl.uniform1i(u.u_lod, item.k);
      gl.uniform1f(u.u_texelPx, (x1 - x0) / (u1 - u0));
      gl.activeTexture(gl.TEXTURE0 + Unit.DATA);
      gl.bindTexture(gl.TEXTURE_2D, item.textures.data);
      gl.activeTexture(gl.TEXTURE0 + Unit.IDS);
      gl.bindTexture(gl.TEXTURE_2D, item.textures.ids);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

// Whether a LOD's texels come from raw bytes or fine summaries, which
// need the NAR on disk, rather than from coarse summaries.
export const needsRaw = (k) => k < LOD_COARSE;
