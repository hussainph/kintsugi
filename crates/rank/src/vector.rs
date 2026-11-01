//! Small vector helpers. Every vector here is either empty (unknown) or
//! normalized, so a dot product is a cosine.

/// The hashed fallback's width, the same as potion-base-8M's.
pub const DIMS: usize = 256;

pub fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|x| *x /= norm);
    }
}

/// Cosine of two normalized vectors; 0 when either is unknown or they differ in width.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// An exponentially decayed, weighted sum of vectors: a taste vector with a
/// half-life. Old likes fade; nothing is ever forgotten outright.
#[derive(Clone, Debug, Default)]
pub struct Centroid {
    sum: Vec<f32>,
    /// Total weight, decayed with the sum.
    pub mass: f64,
    /// Milliseconds: when `sum` and `mass` were last decayed to.
    at: i64,
    half_life_ms: f64,
}

impl Centroid {
    pub fn new(half_life_days: f64) -> Self {
        Centroid { half_life_ms: half_life_days * 86_400_000.0, ..Default::default() }
    }

    fn decay_to(&mut self, at: i64) {
        if at <= self.at || self.mass == 0.0 {
            self.at = self.at.max(at);
            return;
        }
        let factor = 0.5f64.powf((at - self.at) as f64 / self.half_life_ms);
        self.sum.iter_mut().for_each(|x| *x *= factor as f32);
        self.mass *= factor;
        self.at = at;
    }

    /// Adds `vector` with `weight` at time `at` (ms). An event older than the
    /// centroid's clock is decayed by its own age instead.
    pub fn add(&mut self, vector: &[f32], weight: f64, at: i64) {
        if vector.is_empty() || weight <= 0.0 {
            return;
        }
        if self.sum.len() != vector.len() {
            self.sum = vec![0.0; vector.len()];
            self.mass = 0.0;
        }
        let weight = if at < self.at { weight * 0.5f64.powf((self.at - at) as f64 / self.half_life_ms) } else { weight };
        self.decay_to(at);
        for (s, x) in self.sum.iter_mut().zip(vector) {
            *s += x * weight as f32;
        }
        self.mass += weight;
    }

    /// The direction of taste (normalized), or empty when there's none.
    pub fn direction(&self) -> Vec<f32> {
        if self.mass <= 1e-9 {
            return Vec::new();
        }
        let mut out = self.sum.clone();
        normalize(&mut out);
        out
    }

    /// The mass as it would be at `at`.
    pub fn mass_at(&self, at: i64) -> f64 {
        if at <= self.at {
            return self.mass;
        }
        self.mass * 0.5f64.powf((at - self.at) as f64 / self.half_life_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centroids_decay_by_half_life() {
        let day = 86_400_000;
        let mut short = Centroid::new(7.0);
        short.add(&[1.0, 0.0], 1.0, 0);
        short.add(&[0.0, 1.0], 1.0, 7 * day);
        // The older vector counts half as much a half-life later.
        let d = short.direction();
        assert!((d[1] / d[0] - 2.0).abs() < 1e-4, "{d:?}");
        assert!((short.mass_at(14 * day) - 0.75).abs() < 1e-9);
        assert!(Centroid::new(90.0).direction().is_empty());
    }
}
