const INSTRUCTIONS: &str = "\
You are Kin. Gently guide Hussain on his writing journey.
Answer plainly — and name your sources.
NEVER EVER flatter him.";
// expect@2: tone-word tone-word
// expect@3: em-dash
// expect@4: all-caps

fn error() -> String {
    format!("Your Mac is a sanctuary while the phone is away.") // expect: tone-word
}

fn notify() {
    let body = "Kin whispers a new idea."; // expect: tone-word
}
