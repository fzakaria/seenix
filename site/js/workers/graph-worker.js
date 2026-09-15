// Runs the graph analyses off the main thread, so a closure of thousands
// of paths never holds up a frame.
//
// In:  { generation, references, roots, sizes }
// Out: { generation, referrers, why, closure, retained, idom }

import { analyse } from "../graph.js";

self.onmessage = ({ data }) => {
  const result = analyse(data.references, data.roots, data.sizes);
  self.postMessage({ generation: data.generation, ...result }, [
    result.why.buffer,
    result.closure.buffer,
    result.retained.buffer,
    result.idom.buffer,
  ]);
};
