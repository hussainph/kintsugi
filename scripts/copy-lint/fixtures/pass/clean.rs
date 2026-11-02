//! Kintsugi: gold in the seams. Comments are not copy.

const SQL: &str = "SELECT id FROM items WHERE seen IS NULL AND kept IS NOT NULL";

fn errors() -> Result<(), String> {
    log::warn!("the soul of the feed — failed");
    eprintln!("quietly retrying");
    let lifetime: &'static str = "plain";
    let c = 'x';
    Err("Couldn't reach your Mac. Try again when it's back.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn sample() {
        assert_eq!("Mending with gold, along the seams — quietly.", "x");
    }
}

#[cfg(all(test, feature = "headless"))]
fn seed() -> &'static str {
    "Gold in the cracks: a journey."
}
