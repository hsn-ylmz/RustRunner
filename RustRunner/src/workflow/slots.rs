//! Command placeholders and named file slots.
//!
//! A command can hold placeholders in braces. The engine fills them just
//! before the command runs:
//!
//! | Placeholder | Filled with |
//! |---|---|
//! | `{input}`, `{inputs}` | the step's `input` files |
//! | `{output}`, `{outputs}` | the step's `output` files |
//! | `{threads}` | the step's thread count |
//! | `{name}` | the files of the named input or output `name` |
//!
//! Steps without `named_inputs` and `named_outputs` keep the original, plain
//! behaviour: the four `{input}`-style placeholders are replaced and nothing
//! else is looked at, so existing commands (`awk '{print $1}'`) are never
//! second-guessed.
//!
//! Steps that use named slots get the strict rules:
//!
//! * a `{name}` that is neither a built-in placeholder nor a slot of the step
//!   is an error naming it, and so is a slot that has no file;
//! * `{{name}}` stands for the literal text `{name}`;
//! * every file is shell-quoted for the place it lands in: unquoted, inside
//!   single quotes or inside double quotes. A path with spaces, quotes, `$`
//!   or backticks therefore always reaches the tool as one literal argument;
//! * a placeholder in a place that cannot be filled safely (a here-document,
//!   a `$'...'` string, a double-quoted string that also holds `$(...)` or a
//!   backtick) is an error: write it outside the quotes instead. Placeholders
//!   in `#` comments are left alone.
//!
//! The quote tracking understands single and double quotes, backslash
//! escapes, `$'...'`, `${...}`, comments and here-documents. A command that
//! plays tricks beyond that should keep its placeholders in plain words.

use std::collections::HashMap;

use super::model::Step;

/// Placeholders the engine fills for every step.
pub const BUILTIN_PLACEHOLDERS: [&str; 5] = ["input", "output", "inputs", "outputs", "threads"];

/// Longest slot name the engine accepts.
pub const MAX_SLOT_NAME_LEN: usize = 40;

/// True when `name` is `[A-Za-z_][A-Za-z0-9_]*`.
pub fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Why `name` cannot name a slot, or `None` when it can.
pub fn slot_name_problem(name: &str) -> Option<String> {
    if !is_identifier(name) {
        return Some(format!(
            "'{}' is not a valid slot name: start with a letter or underscore, then use letters, digits and underscores",
            name
        ));
    }
    if name.chars().count() > MAX_SLOT_NAME_LEN {
        return Some(format!(
            "slot name '{}' is longer than {} characters",
            name, MAX_SLOT_NAME_LEN
        ));
    }
    if BUILTIN_PLACEHOLDERS.contains(&name.to_ascii_lowercase().as_str()) {
        return Some(format!(
            "'{}' is a built-in placeholder and cannot name a slot",
            name
        ));
    }
    None
}

/// Quotes a single string for safe use as one POSIX shell word.
///
/// Wraps the value in single quotes and escapes any embedded single quote as
/// `'\''`, which is the standard way to make an arbitrary string a single
/// shell argument.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Shell-quotes each file and joins them with spaces for command substitution.
pub fn shell_join(files: &[String]) -> String {
    files
        .iter()
        .map(|f| shell_quote(f))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Where a placeholder sits relative to the command's quotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quote {
    /// Plain shell text.
    None,
    /// Inside `'...'`.
    Single,
    /// Inside `"..."`.
    Double,
    /// Inside `$'...'`.
    AnsiC,
}

/// One piece of a scanned command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    /// Text that is copied as it is (`{{x}}` already turned into `{x}`).
    Text(String),
    /// A `{name}` placeholder.
    Hole {
        name: String,
        quote: Quote,
        /// Set when the placeholder cannot be filled safely where it is.
        problem: Option<&'static str>,
    },
}

const PROBLEM_ANSI: &str = "it is inside a $'...' string";
const PROBLEM_HEREDOC: &str = "it follows a here-document (<<)";
const PROBLEM_NESTED: &str =
    "it follows a double-quoted string that also holds $(...) or a backtick";

/// If `chars[i..]` starts with `{identifier}`, returns the identifier and the
/// index just after the closing brace.
fn brace_name(chars: &[char], i: usize) -> Option<(String, usize)> {
    if chars.get(i) != Some(&'{') {
        return None;
    }
    let mut j = i + 1;
    let mut name = String::new();
    while let Some(&c) = chars.get(j) {
        if c == '}' {
            return is_identifier(&name).then_some((name, j + 1));
        }
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        name.push(c);
        j += 1;
    }
    None
}

/// Splits a command into plain text and placeholders, tracking the shell
/// quoting around each placeholder (see the module docs for what is tracked).
pub fn scan(command: &str) -> Vec<Part> {
    let chars: Vec<char> = command.chars().collect();
    let mut parts = Vec::new();
    let mut text = String::new();
    let mut quote = Quote::None;
    // Set once the quoting can no longer be followed reliably.
    let mut sticky: Option<&'static str> = None;
    let mut in_comment = false;
    let mut word_start = true;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();

        if in_comment {
            text.push(c);
            if c == '\n' {
                in_comment = false;
                word_start = true;
            }
            i += 1;
            continue;
        }

        // A backslash escapes the next character everywhere but in '...'.
        if c == '\\' && quote != Quote::Single {
            text.push(c);
            if let Some(n) = next {
                text.push(n);
            }
            i += 2;
            word_start = false;
            continue;
        }

        // ${...} is bash's own expansion: copy it through its matching brace.
        if c == '$' && next == Some('{') && quote != Quote::Single {
            let mut depth = 0;
            while i < chars.len() {
                text.push(chars[i]);
                match chars[i] {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            i += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            word_start = false;
            continue;
        }

        if quote == Quote::Double && (c == '`' || (c == '$' && next == Some('('))) {
            sticky = sticky.or(Some(PROBLEM_NESTED));
        }

        if c == '{' {
            // {{name}} is an escaped, literal {name}.
            if next == Some('{') {
                if let Some((name, end)) = brace_name(&chars, i + 1) {
                    if chars.get(end) == Some(&'}') {
                        text.push('{');
                        text.push_str(&name);
                        text.push('}');
                        i = end + 1;
                        word_start = false;
                        continue;
                    }
                }
            }
            if let Some((name, end)) = brace_name(&chars, i) {
                if !text.is_empty() {
                    parts.push(Part::Text(std::mem::take(&mut text)));
                }
                let problem = match quote {
                    Quote::AnsiC => Some(PROBLEM_ANSI),
                    _ => sticky,
                };
                parts.push(Part::Hole {
                    name,
                    quote,
                    problem,
                });
                i = end;
                word_start = false;
                continue;
            }
        }

        match quote {
            Quote::Single | Quote::AnsiC => {
                if c == '\'' {
                    quote = Quote::None;
                }
            }
            Quote::Double => {
                if c == '"' {
                    quote = Quote::None;
                }
            }
            Quote::None => match c {
                '\'' => quote = Quote::Single,
                '"' => quote = Quote::Double,
                '$' if next == Some('\'') => {
                    text.push(c);
                    text.push('\'');
                    quote = Quote::AnsiC;
                    i += 2;
                    word_start = false;
                    continue;
                }
                '#' if word_start => in_comment = true,
                '<' if next == Some('<')
                    && chars.get(i + 2) != Some(&'<')
                    && (i == 0 || chars[i - 1] != '<') =>
                {
                    sticky = sticky.or(Some(PROBLEM_HEREDOC));
                }
                _ => {}
            },
        }
        word_start =
            quote == Quote::None && (c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')'));
        text.push(c);
        i += 1;
    }
    if !text.is_empty() {
        parts.push(Part::Text(text));
    }
    parts
}

/// The placeholder names a command uses, in order of first use. Names inside
/// comments, `${...}` and `{{...}}` escapes are not counted.
pub fn placeholder_names(command: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for part in scan(command) {
        if let Part::Hole { name, .. } = part {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// Files of every slot ordered by name, for stable output.
pub fn sorted_slots(map: &HashMap<String, Vec<String>>) -> Vec<(&str, &[String])> {
    let mut slots: Vec<(&str, &[String])> = map
        .iter()
        .map(|(name, files)| (name.as_str(), files.as_slice()))
        .collect();
    slots.sort_by(|a, b| a.0.cmp(b.0));
    slots
}

/// Escapes `file` for the inside of a `"..."` string.
fn escape_double(file: &str) -> String {
    let mut out = String::with_capacity(file.len());
    for c in file.chars() {
        if matches!(c, '\\' | '"' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Joins `files` for the place a placeholder sits in.
fn fill(files: &[String], quote: Quote) -> String {
    match quote {
        Quote::None | Quote::AnsiC => shell_join(files),
        Quote::Single => files
            .iter()
            .map(|f| f.replace('\'', "'\\''"))
            .collect::<Vec<_>>()
            .join(" "),
        Quote::Double => files
            .iter()
            .map(|f| escape_double(f))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// What a placeholder stands for in `step`.
enum Binding {
    Files(Vec<String>),
    /// The thread count, written bare.
    Threads(String),
    /// An optional slot that has no file: it expands to nothing.
    Empty,
    /// A slot of the step that has no usable file.
    Unbound,
    Unknown,
}

fn binding_of(step: &Step, name: &str) -> Binding {
    match name {
        "input" | "inputs" => Binding::Files(step.plain_inputs()),
        "output" | "outputs" => Binding::Files(step.plain_outputs()),
        "threads" => Binding::Threads(step.threads.to_string()),
        _ => match step
            .named_inputs
            .get(name)
            .or_else(|| step.named_outputs.get(name))
        {
            Some(files) if !files.is_empty() && files.iter().all(|f| !f.trim().is_empty()) => {
                Binding::Files(files.clone())
            }
            Some(files) if files.is_empty() && step.optional_slots.iter().any(|n| n == name) => {
                Binding::Empty
            }
            Some(_) => Binding::Unbound,
            None => Binding::Unknown,
        },
    }
}

/// Problems with how the step's slots are declared, independent of the
/// command: invalid or reserved names, a name used for both an input and an
/// output, a name that is also a wildcard, blank file names.
pub fn declaration_problems(step: &Step) -> Vec<String> {
    let mut problems = Vec::new();
    for (kind, map) in [
        ("named_inputs", &step.named_inputs),
        ("named_outputs", &step.named_outputs),
    ] {
        for (name, files) in sorted_slots(map) {
            if let Some(problem) = slot_name_problem(name) {
                problems.push(format!("Step '{}': {} {}", step.id, kind, problem));
            }
            if files
                .iter()
                .any(|f| f.trim().is_empty() || f.contains('\0'))
            {
                problems.push(format!(
                    "Step '{}': slot '{}' has an empty or invalid file name",
                    step.id, name
                ));
            }
            if step.wildcard_files.contains_key(name) {
                problems.push(format!(
                    "Step '{}': slot '{}' has the same name as a wildcard; rename one of them",
                    step.id, name
                ));
            }
        }
    }
    for name in &step.optional_slots {
        if !step.named_inputs.contains_key(name) {
            problems.push(format!(
                "Step '{}': optional slot '{}' is not one of the step's named inputs",
                step.id, name
            ));
        }
    }
    for (name, _) in sorted_slots(&step.named_inputs) {
        if step.named_outputs.contains_key(name) {
            problems.push(format!(
                "Step '{}': '{}' is both a named input and a named output; give them different names",
                step.id, name
            ));
        }
    }
    problems
}

/// Fills a step's command.
///
/// For a step without named slots this is the original plain replacement of
/// `{input}`, `{output}`, `{inputs}`, `{outputs}` (and `{threads}`), which
/// never fails. For a step with named slots every placeholder must resolve,
/// and the errors name each one that does not.
pub fn render_command(step: &Step) -> Result<String, Vec<String>> {
    if !step.is_structured() {
        let inputs = shell_join(&step.plain_inputs());
        let outputs = shell_join(&step.plain_outputs());
        return Ok(step
            .command
            .replace("{input}", &inputs)
            .replace("{output}", &outputs)
            .replace("{inputs}", &inputs)
            .replace("{outputs}", &outputs)
            .replace("{threads}", &step.threads.to_string()));
    }

    let mut out = String::new();
    let mut errors: Vec<String> = Vec::new();
    fn note(message: String, errors: &mut Vec<String>) {
        if !errors.contains(&message) {
            errors.push(message);
        }
    }
    for part in scan(&step.command) {
        match part {
            Part::Text(text) => out.push_str(&text),
            Part::Hole {
                name,
                quote,
                problem,
            } => match binding_of(step, &name) {
                Binding::Unknown => note(
                    format!(
                        "Step '{}': the command uses {{{name}}}, but the step has no input or output called \"{name}\". \
                         Bind a file to \"{name}\", or write {{{{{name}}}}} to keep the braces as text",
                        step.id
                    ),
                    &mut errors,
                ),
                Binding::Unbound => note(
                    format!(
                        "Step '{}': {{{name}}} has no file. Choose a file for \"{name}\"",
                        step.id
                    ),
                    &mut errors,
                ),
                Binding::Files(_) | Binding::Threads(_) if problem.is_some() => note(
                    format!(
                        "Step '{}': {{{name}}} cannot be filled safely because {}. Move it outside the quotes: the engine quotes file names itself",
                        step.id,
                        problem.unwrap_or_default()
                    ),
                    &mut errors,
                ),
                Binding::Threads(n) => out.push_str(&n),
                Binding::Empty => {}
                Binding::Files(files) => out.push_str(&fill(&files, quote)),
            },
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

/// The command as the run log and the report show it: with the slots filled
/// in for a step that has named slots (what actually runs), and as written
/// for any other step. Falls back to the text as written when a placeholder
/// cannot be filled.
pub fn display_command(step: &Step) -> String {
    if step.is_structured() {
        if let Ok(text) = render_command(step) {
            return text;
        }
    }
    step.command.clone()
}

/// Every problem with the step's slots and its command's placeholders, ready
/// to show. Empty for a step without named slots.
pub fn slot_problems(step: &Step) -> Vec<String> {
    if !step.is_structured() {
        return Vec::new();
    }
    let mut problems = declaration_problems(step);
    if let Err(errors) = render_command(step) {
        problems.extend(errors);
    }
    problems
}

/// Names of slots the command never uses (worth a warning, not an error).
pub fn unused_slots(step: &Step) -> Vec<String> {
    let used = placeholder_names(&step.command);
    let mut unused: Vec<String> = step
        .named_inputs
        .keys()
        .chain(step.named_outputs.keys())
        .filter(|name| !used.contains(name))
        .cloned()
        .collect();
    unused.sort();
    unused
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(command: &str) -> Step {
        Step::new("s", "bash", command)
    }

    fn holes(command: &str) -> Vec<(String, Quote, bool)> {
        scan(command)
            .into_iter()
            .filter_map(|p| match p {
                Part::Hole {
                    name,
                    quote,
                    problem,
                } => Some((name, quote, problem.is_some())),
                Part::Text(_) => None,
            })
            .collect()
    }

    // ---- names ----

    #[test]
    fn test_slot_names() {
        assert!(slot_name_problem("ref").is_none());
        assert!(slot_name_problem("_r1").is_none());
        assert!(slot_name_problem("reads2").is_none());
        assert!(slot_name_problem("2reads").is_some());
        assert!(slot_name_problem("my-ref").is_some());
        assert!(slot_name_problem("").is_some());
        assert!(slot_name_problem("a b").is_some());
        assert!(slot_name_problem(&"x".repeat(41)).is_some());
        for builtin in ["input", "output", "inputs", "outputs", "threads", "INPUT"] {
            assert!(slot_name_problem(builtin).is_some(), "{}", builtin);
        }
    }

    // ---- scanning ----

    #[test]
    fn test_scan_finds_placeholders_in_order_without_repeats() {
        assert_eq!(
            placeholder_names("bwa mem {ref} {reads} > {sam} && ls {ref}"),
            vec!["ref", "reads", "sam"]
        );
    }

    #[test]
    fn test_scan_ignores_bash_expansions_and_non_identifiers() {
        assert_eq!(
            placeholder_names("echo ${HOME} ${X:-{ref}} {a,b} {1..3} {print $1} { x }"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn test_scan_escape_gives_literal_braces() {
        let s = step("echo {{ref}} {ref}").with_named_input("ref", &["a.fa"]);
        assert_eq!(render_command(&s).unwrap(), "echo {ref} 'a.fa'");
        assert_eq!(placeholder_names("echo {{ref}}"), Vec::<String>::new());
    }

    #[test]
    fn test_scan_tracks_quote_state() {
        assert_eq!(
            holes("a {x} 'b {y}' \"c {z}\" d {w}"),
            vec![
                ("x".to_string(), Quote::None, false),
                ("y".to_string(), Quote::Single, false),
                ("z".to_string(), Quote::Double, false),
                ("w".to_string(), Quote::None, false),
            ]
        );
    }

    #[test]
    fn test_scan_backslash_and_nested_quotes() {
        // The escaped quote does not open a string; the quote inside "..."
        // does not close it.
        assert_eq!(
            holes(r#"echo \' {a} "it's {b}" 'say "{c}"'"#),
            vec![
                ("a".to_string(), Quote::None, false),
                ("b".to_string(), Quote::Double, false),
                ("c".to_string(), Quote::Single, false),
            ]
        );
    }

    #[test]
    fn test_scan_comments_hide_placeholders() {
        assert_eq!(
            holes("echo {a} # don't use {b}\necho {c}"),
            vec![
                ("a".to_string(), Quote::None, false),
                ("c".to_string(), Quote::None, false),
            ]
        );
        // A # inside a word is not a comment.
        assert_eq!(
            holes("echo a#{b}"),
            vec![("b".to_string(), Quote::None, false)]
        );
    }

    #[test]
    fn test_scan_flags_unsafe_contexts() {
        assert_eq!(
            holes("echo $'a{b}'"),
            vec![("b".to_string(), Quote::AnsiC, true)]
        );
        assert_eq!(
            holes("cat <<EOF\n{a}\nEOF"),
            vec![("a".to_string(), Quote::None, true)]
        );
        assert_eq!(
            holes("echo \"$(date) {a}\" {b}"),
            vec![
                ("a".to_string(), Quote::Double, true),
                ("b".to_string(), Quote::None, true),
            ]
        );
        // A here-string is plain text.
        assert_eq!(
            holes("cat <<< {a}"),
            vec![("a".to_string(), Quote::None, false)]
        );
    }

    // ---- rendering ----

    #[test]
    fn test_plain_step_keeps_original_behaviour() {
        let s = step("awk '{print $1}' {input} > {output} # {unknown}")
            .with_input("a b.txt")
            .with_output("o.txt");
        assert_eq!(
            render_command(&s).unwrap(),
            "awk '{print $1}' 'a b.txt' > 'o.txt' # {unknown}"
        );
        let s = step("run {foo} {threads}").with_threads(3);
        assert_eq!(render_command(&s).unwrap(), "run {foo} 3");
    }

    #[test]
    fn test_slots_fill_and_quote_each_file() {
        let s = step("bwa mem {ref} {reads} > {sam}")
            .with_named_input("ref", &["genome.fa"])
            .with_named_input("reads", &["r 1.fq", "r2.fq"])
            .with_named_output("sam", &["out dir/a.sam"]);
        assert_eq!(
            render_command(&s).unwrap(),
            "bwa mem 'genome.fa' 'r 1.fq' 'r2.fq' > 'out dir/a.sam'"
        );
    }

    #[test]
    fn test_builtins_work_beside_slots() {
        let s = step("tool -t {threads} {input} {ref} -o {output}")
            .with_input("in.txt")
            .with_output("out.txt")
            .with_threads(4)
            .with_named_input("ref", &["r.fa"]);
        assert_eq!(
            render_command(&s).unwrap(),
            "tool -t 4 'in.txt' 'r.fa' -o 'out.txt'"
        );
    }

    #[test]
    fn test_hostile_paths_unquoted() {
        let evil = [
            "my sample; rm -rf ~.fq",
            "$(touch pwned).fq",
            "`touch pwned`.fq",
            "it's.fq",
            "a\"b.fq",
            "back\\slash.fq",
            "new\nline.fq",
            "$HOME/${USER}.fq",
            "-rf",
            "*.fq",
            "a&b|c>d<e.fq",
        ];
        for path in evil {
            let s = step("cat {f}").with_named_input("f", &[path]);
            let cmd = render_command(&s).unwrap();
            assert_eq!(cmd, format!("cat {}", shell_quote(path)), "{}", path);
        }
    }

    #[test]
    fn test_hostile_paths_in_single_quotes() {
        let s = step("echo 'file: {f}'").with_named_input("f", &["it's $(x).fq"]);
        assert_eq!(render_command(&s).unwrap(), "echo 'file: it'\\''s $(x).fq'");
    }

    #[test]
    fn test_hostile_paths_in_double_quotes() {
        let s = step("echo \"file: {f}\"").with_named_input("f", &["a \"b\" $(x) `y` \\z $HOME"]);
        assert_eq!(
            render_command(&s).unwrap(),
            "echo \"file: a \\\"b\\\" \\$(x) \\`y\\` \\\\z \\$HOME\""
        );
    }

    #[test]
    fn test_unknown_placeholder_names_the_slot() {
        let s = step("run {ref} {oops}").with_named_input("ref", &["r.fa"]);
        let errors = render_command(&s).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("{oops}"), "{}", errors[0]);
        assert!(errors[0].contains("Step 's'"), "{}", errors[0]);
    }

    #[test]
    fn test_unbound_slot_names_the_slot() {
        for files in [&[][..], &[" "][..]] {
            let s = step("run {ref}").with_named_input("ref", files);
            let errors = render_command(&s).unwrap_err();
            assert!(
                errors[0].contains("{ref}") && errors[0].contains("no file"),
                "{:?}",
                errors
            );
        }
    }

    #[test]
    fn test_every_problem_is_listed_once() {
        let s = step("run {a} {b} {a} {c}").with_named_input("c", &[]);
        let errors = render_command(&s).unwrap_err();
        assert_eq!(errors.len(), 3);
    }

    #[test]
    fn test_unsafe_context_is_an_error() {
        let s = step("cat <<EOF\n{f}\nEOF").with_named_input("f", &["a.txt"]);
        let errors = render_command(&s).unwrap_err();
        assert!(errors[0].contains("here-document"), "{}", errors[0]);
        let s = step("echo $'{f}'").with_named_input("f", &["a.txt"]);
        assert!(render_command(&s).is_err());
    }

    #[test]
    fn test_comment_placeholders_are_left_alone() {
        let s = step("echo {f} # {nothing}\necho {f}").with_named_input("f", &["a\nb"]);
        // The newline in the path stays inside quotes, not inside the comment.
        assert_eq!(
            render_command(&s).unwrap(),
            "echo 'a\nb' # {nothing}\necho 'a\nb'"
        );
    }

    #[test]
    fn test_threads_in_structured_step() {
        let s = step("t -p {threads} {f}")
            .with_threads(8)
            .with_named_input("f", &["a"]);
        assert_eq!(render_command(&s).unwrap(), "t -p 8 'a'");
    }

    #[test]
    fn test_output_slot_is_just_a_slot() {
        let s = step("t > {bam}").with_named_output("bam", &["x.bam"]);
        assert_eq!(render_command(&s).unwrap(), "t > 'x.bam'");
    }

    // ---- declaration problems ----

    #[test]
    fn test_declaration_problems() {
        let s = step("x")
            .with_named_input("bad-name", &["a"])
            .with_named_input("input", &["a"])
            .with_named_input("both", &["a"])
            .with_named_output("both", &["b"])
            .with_named_input("blank", &[" "]);
        let problems = declaration_problems(&s).join("\n");
        assert!(problems.contains("bad-name"), "{}", problems);
        assert!(problems.contains("'input'"), "{}", problems);
        assert!(problems.contains("both"), "{}", problems);
        assert!(problems.contains("blank"), "{}", problems);
    }

    #[test]
    fn test_slot_named_like_a_wildcard_is_rejected() {
        let mut s = step("x {sample}").with_named_input("sample", &["a"]);
        s.wildcard_files
            .insert("sample".into(), vec!["a.fq".into()]);
        assert!(slot_problems(&s).join("\n").contains("wildcard"));
    }

    #[test]
    fn test_plain_step_has_no_slot_problems() {
        assert!(slot_problems(&step("awk '{print}' {nothing}")).is_empty());
    }

    #[test]
    fn test_unused_slots() {
        let s = step("run {a}")
            .with_named_input("a", &["x"])
            .with_named_input("z", &["y"])
            .with_named_output("m", &["o"]);
        assert_eq!(unused_slots(&s), vec!["m", "z"]);
    }

    // ---- optional slots ----

    #[test]
    fn test_optional_empty_slot_expands_to_nothing() {
        let step = Step::new("a", "bash", "bwa mem {ref} {r1} {r2} > {sam}")
            .with_named_input("ref", &["g.fa"])
            .with_named_input("r1", &["a.fq"])
            .with_named_input("r2", &[])
            .with_named_output("sam", &["o.sam"])
            .with_optional_slots(&["r2"]);
        assert_eq!(
            render_command(&step).unwrap(),
            "bwa mem 'g.fa' 'a.fq'  > 'o.sam'"
        );
    }

    #[test]
    fn test_optional_slot_with_a_file_is_filled_as_usual() {
        let step = Step::new("a", "bash", "run {r1} {r2}")
            .with_named_input("r1", &["a.fq"])
            .with_named_input("r2", &["b.fq"])
            .with_optional_slots(&["r2"]);
        assert_eq!(render_command(&step).unwrap(), "run 'a.fq' 'b.fq'");
    }

    #[test]
    fn test_only_listed_slots_may_be_empty() {
        let step = Step::new("a", "bash", "run {r1} {r2}")
            .with_named_input("r1", &[])
            .with_named_input("r2", &[])
            .with_optional_slots(&["r2"]);
        let errors = render_command(&step).unwrap_err();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("{r1}"));
    }

    #[test]
    fn test_optional_slot_must_be_declared_as_a_named_input() {
        let step = Step::new("a", "bash", "run {r1}")
            .with_named_input("r1", &["a.fq"])
            .with_optional_slots(&["nope"]);
        let problems = declaration_problems(&step);
        assert!(problems.iter().any(|p| p.contains("nope")), "{problems:?}");
    }
}
