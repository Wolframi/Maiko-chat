//! Rust/WASM version of maikoParticleMotion's neighbour graph.
//! Keep f64 arithmetic and traversal order to preserve JS neighbours, including ties.
const HASH_SIZE: usize = 131072;

fn hash(x: i32, y: i32, z: i32) -> usize {
    ((x.wrapping_mul(73856093) ^ y.wrapping_mul(19349663) ^ z.wrapping_mul(83492791)) as usize)
        & (HASH_SIZE - 1)
}

pub struct Graph {
    data: Vec<f32>,
    neighbours: Vec<i32>,
    heads: Vec<i32>,
    next: Vec<i32>,
    cells: Vec<i32>,
    count: usize,
    contact: f64,
    cursor: usize,
    grid_ready: bool,
}

impl Graph {
    fn new(count: usize) -> Self {
        Self {
            data: vec![0.0; count * 16],
            neighbours: vec![-1; count * 3],
            heads: vec![-1; HASH_SIZE],
            next: vec![0; count],
            cells: vec![0; count * 3],
            count,
            contact: (0.007 * (84000.0 / count as f64).sqrt()).clamp(0.007, 0.022),
            cursor: 0,
            grid_ready: false,
        }
    }

    fn step(&mut self) -> bool {
        let size = self.contact * 2.0;
        if !self.grid_ready {
            let end = (self.cursor + 1024).min(self.count);
            for i in self.cursor..end {
                let k = i * 3;
                let d = i * 16;
                let x = (self.data[d] as f64 / size).floor() as i32;
                let y = (self.data[d + 1] as f64 / size).floor() as i32;
                let z = (self.data[d + 2] as f64 / size).floor() as i32;
                self.cells[k..k + 3].copy_from_slice(&[x, y, z]);
                let bucket = hash(x, y, z);
                self.next[i] = self.heads[bucket];
                self.heads[bucket] = i as i32;
            }
            self.cursor = end;
            if end == self.count {
                self.grid_ready = true;
                self.cursor = 0;
            }
            return false;
        }
        let end = (self.cursor + 64).min(self.count);
        for i in self.cursor..end {
            let k = i * 3;
            let d = i * 16;
            let (cx, cy, cz) = (self.cells[k], self.cells[k + 1], self.cells[k + 2]);
            let mut best = [size * size; 3];
            for x in cx - 1..=cx + 1 {
                for y in cy - 1..=cy + 1 {
                    for z in cz - 1..=cz + 1 {
                        let mut j = self.heads[hash(x, y, z)];
                        while j != -1 {
                            let index = j as usize;
                            let q = index * 3;
                            let e = index * 16;
                            if i != index
                                && self.cells[q] == x
                                && self.cells[q + 1] == y
                                && self.cells[q + 2] == z
                            {
                                let dx = self.data[d] as f64 - self.data[e] as f64;
                                let dy = self.data[d + 1] as f64 - self.data[e + 1] as f64;
                                let dz = self.data[d + 2] as f64 - self.data[e + 2] as f64;
                                let distance = dx * dx + dy * dy + dz * dz;
                                if distance < best[0] {
                                    best[2] = best[1];
                                    best[1] = best[0];
                                    best[0] = distance;
                                    self.neighbours[k + 2] = self.neighbours[k + 1];
                                    self.neighbours[k + 1] = self.neighbours[k];
                                    self.neighbours[k] = j;
                                } else if distance < best[1] {
                                    best[2] = best[1];
                                    best[1] = distance;
                                    self.neighbours[k + 2] = self.neighbours[k + 1];
                                    self.neighbours[k + 1] = j;
                                } else if distance < best[2] {
                                    best[2] = distance;
                                    self.neighbours[k + 2] = j;
                                }
                            }
                            j = self.next[index];
                        }
                    }
                }
            }
        }
        self.cursor = end;
        end == self.count
    }
}

// The ABI is private to maikoParticleWasm.ts. Handles never escape its calls.
#[no_mangle]
pub extern "C" fn graph_new(count: u32) -> *mut Graph {
    if !(1..=100000).contains(&count) {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Graph::new(count as usize)))
}

/// # Safety
/// `graph` must be a live handle returned by graph_new.
#[no_mangle]
pub unsafe extern "C" fn graph_data(graph: *mut Graph) -> *mut f32 {
    (*graph).data.as_mut_ptr()
}

/// # Safety
/// `graph` must be a live handle returned by graph_new.
#[no_mangle]
pub unsafe extern "C" fn graph_result(graph: *const Graph) -> *const i32 {
    (*graph).neighbours.as_ptr()
}

/// # Safety
/// `graph` must be a live handle returned by graph_new.
#[no_mangle]
pub unsafe extern "C" fn graph_contact(graph: *const Graph) -> f64 {
    (*graph).contact
}

/// # Safety
/// `graph` must be live, its input initialized, and coordinates finite and bounded.
#[no_mangle]
pub unsafe extern "C" fn graph_step(graph: *mut Graph) -> u32 {
    (*graph).step() as u32
}

/// # Safety
/// `graph` must be a live handle returned by graph_new, released exactly once.
#[no_mangle]
pub unsafe extern "C" fn graph_free(graph: *mut Graph) {
    drop(Box::from_raw(graph));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearby_points_and_ties_follow_insertion_order() {
        let mut graph = Graph::new(4);
        graph.data[16] = 0.001;
        graph.data[32] = -0.001;
        graph.data[48] = 1.0;
        while !graph.step() {}
        assert_eq!(&graph.neighbours[0..3], &[2, 1, -1]);
        assert_eq!(&graph.neighbours[9..12], &[-1, -1, -1]);
    }

    #[test]
    fn single_point_and_count_limits() {
        let mut graph = Graph::new(1);
        while !graph.step() {}
        assert_eq!(graph.neighbours, [-1; 3]);
        assert_eq!(graph.contact, 0.022);
        assert!(graph_new(0).is_null());
        assert!(graph_new(100001).is_null());
    }
}
