//! Online logistic regression: FTRL-Proximal (McMahan et al., 2013) with L1
//! and L2, learning a residual on top of hand-set prior weights, so the
//! first day already ranks sensibly and every action moves it a little.

#[derive(Clone, Debug)]
pub struct Ftrl {
    alpha: f64,
    beta: f64,
    l1: f64,
    l2: f64,
    z: Vec<f64>,
    n: Vec<f64>,
}

pub fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x.clamp(-30.0, 30.0)).exp())
}

impl Ftrl {
    pub fn new(dims: usize) -> Self {
        Ftrl { alpha: 0.5, beta: 1.0, l1: 0.01, l2: 0.5, z: vec![0.0; dims], n: vec![0.0; dims] }
    }

    /// The learned residual for one coordinate.
    pub fn weight(&self, i: usize) -> f64 {
        let z = self.z[i];
        if z.abs() <= self.l1 {
            return 0.0;
        }
        -(z - z.signum() * self.l1) / ((self.beta + self.n[i].sqrt()) / self.alpha + self.l2)
    }

    pub fn weights(&self) -> Vec<f64> {
        (0..self.z.len()).map(|i| self.weight(i)).collect()
    }

    pub fn logit(&self, prior: &[f64], x: &[f64]) -> f64 {
        x.iter().enumerate().map(|(i, xi)| (prior[i] + self.weight(i)) * xi).sum()
    }

    pub fn predict(&self, prior: &[f64], x: &[f64]) -> f64 {
        sigmoid(self.logit(prior, x))
    }

    /// One weighted example: `y` is 1 (wanted) or 0 (not).
    pub fn update(&mut self, prior: &[f64], x: &[f64], y: f64, weight: f64) {
        let p = self.predict(prior, x);
        for (i, xi) in x.iter().enumerate() {
            if *xi == 0.0 {
                continue;
            }
            let g = (p - y) * xi * weight;
            let w = self.weight(i);
            let sigma = ((self.n[i] + g * g).sqrt() - self.n[i].sqrt()) / self.alpha;
            self.z[i] += g - sigma * w;
            self.n[i] += g * g;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn learns_a_separable_signal() {
        let mut model = Ftrl::new(3);
        let prior = [0.0; 3];
        for i in 0..400 {
            let good = i % 2 == 0;
            let x = [1.0, if good { 1.0 } else { 0.0 }, 0.5];
            model.update(&prior, &x, if good { 1.0 } else { 0.0 }, 1.0);
        }
        assert!(model.predict(&prior, &[1.0, 1.0, 0.5]) > 0.8);
        assert!(model.predict(&prior, &[1.0, 0.0, 0.5]) < 0.2);
    }
}
