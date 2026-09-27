#!/usr/bin/env python3
"""Short fix recipes for common rustc error codes (borrow checker, types,
traits, resolution) and a few clippy lints. Much shorter than `rustc --explain`.
Unknown codes fall back to the first lines of `rustc --explain` if rustc exists.

usage:
  explain_code.py E0502 [E0382 ...]   recipes for these codes
  explain_code.py --list              the codes this script knows
"""
import subprocess
import sys

R = {
    "E0382": "use of moved value. The value was moved (assigned, passed by value, or consumed by a for loop / into_iter) and used again.\n"
             "fix: pass `&x` / `&mut x` instead of `x`; iterate `for v in &xs`; `.clone()` only if a copy is really needed; "
             "move the later use before the move; for Option use `.as_ref()` / `.take()`.",
    "E0499": "two mutable borrows alive at once.\n"
             "fix: end the first borrow before the second (inner scope, finish using it); split the struct into fields "
             "and borrow fields separately; use indices instead of two `&mut` into one Vec; `split_at_mut` / `get_many_mut`.",
    "E0502": "mutable borrow while an immutable one is still used later (or the reverse).\n"
             "fix: copy/clone the needed value out first (`let first = v[0];`), reorder so the shared borrow's last use "
             "comes before the mutation, or collect results then mutate in a second pass.",
    "E0505": "move out of a value while it is borrowed.\n"
             "fix: end the borrow first, clone the borrowed part, or borrow instead of moving.",
    "E0506": "assign to a value while it is borrowed.\n"
             "fix: finish using the reference before assigning; compute the new value into a local first.",
    "E0507": "cannot move out of a borrow (`&T`, index, or `self.field` behind &self).\n"
             "fix: borrow (`&self.x`), clone, `std::mem::take(&mut self.x)` / `mem::replace`, `Option::take()`, or "
             "`.iter()` instead of `.into_iter()` on a reference.",
    "E0515": "returning a reference to a local.\n"
             "fix: return the owned value (String, Vec) instead of &str/&[T]; or take the data as a parameter and "
             "return a borrow of that.",
    "E0596": "cannot borrow as mutable: the binding or reference is not mut.\n"
             "fix: `let mut x`, take `&mut self` / `&mut T` in the signature, or use interior mutability if shared.",
    "E0597": "borrowed value does not live long enough (dropped while still referenced).\n"
             "fix: declare the owner in an outer scope, store owned data instead of references, or clone into the container.",
    "E0716": "temporary dropped while borrowed (e.g. `let s = String::from(..).as_str();`).\n"
             "fix: bind the temporary to a `let` first, then borrow it.",
    "E0373": "closure may outlive the function but borrows a local (thread::spawn, async, returned closure).\n"
             "fix: `move ||` the closure; clone Arc handles before moving; use `thread::scope` for borrowed data.",
    "E0384": "assign twice to an immutable variable.\nfix: `let mut x`, or shadow with a new `let`.",
    "E0106": "missing lifetime specifier in a returned or stored reference.\n"
             "fix: return an owned type, or add `<'a>` tying output to one input (`fn f<'a>(x: &'a str) -> &'a str`); "
             "structs holding refs need `struct S<'a> { r: &'a T }`.",
    "E0308": "mismatched types.\n"
             "fix: read expected vs found. &str vs String: `.to_string()` / `&s`; Option/Result: `Some(x)`, `?`, "
             "`.unwrap_or(..)`; integers: `as` or `try_from`; a trailing `;` makes a block return `()`; match arms must agree.",
    "E0277": "trait bound not satisfied (the type does not implement the trait).\n"
             "fix: derive it (`#[derive(Debug, Clone, PartialEq)]`), add the bound to the generic (`T: Display`), "
             "convert the type, or for `?` make sure the error converts (From impl / `.map_err`). Send/Sync: Rc→Arc, RefCell→Mutex.",
    "E0599": "no method found for the type.\n"
             "fix: import the trait that provides it (`use std::io::Write;`, `use std::fmt::Write`), call on the right "
             "type (`.iter()` first, deref, `.as_ref()`), or add the missing derive/bound.",
    "E0425": "unresolved name (variable/function not in scope).\n"
             "fix: typo? add `use crate::path::name;`, `self.` for fields, check cfg-gated code and module visibility.",
    "E0433": "failed to resolve a path (unknown crate/module).\n"
             "fix: `use` the right path (`crate::`, `super::`), declare `mod x;`, or check the dependency exists in Cargo.toml "
             "(no network: do not add crates).",
    "E0432": "unresolved import.\nfix: check the module path and `pub` visibility; feature-gated items need the feature enabled.",
    "E0603": "item is private.\nfix: use the public re-export, or make it `pub`/`pub(crate)` if you own the module.",
    "E0061": "wrong number of arguments.\nfix: match the function signature; check every call site after changing a signature.",
    "E0063": "missing struct fields in initializer.\nfix: add the fields, or `..Default::default()` if the type implements Default.",
    "E0027": "pattern misses struct fields.\nfix: list them or add `..` to the pattern.",
    "E0004": "non-exhaustive match.\nfix: handle the new variants, or add `_ =>` only if a catch-all is truly right.",
    "E0282": "type annotations needed.\nfix: annotate the binding (`let v: Vec<u32> =`) or turbofish (`collect::<Vec<_>>()`, `parse::<i64>()`).",
    "E0283": "ambiguous type (several impls fit).\nfix: annotate the type, e.g. `let x: u64 = s.parse()?` or `.into()` target type.",
    "E0046": "trait impl is missing items.\nfix: implement every required method/type from the trait definition.",
    "E0053": "method signature does not match the trait.\nfix: copy the exact signature from the trait (self kind, lifetimes, types).",
    "E0369": "binary operator not supported for the type.\nfix: derive/impl PartialEq/PartialOrd/Add, or compare fields/references (`*a == b`).",
    "E0614": "cannot dereference a non-pointer.\nfix: remove the `*`; the value is already owned or Copy.",
    "E0015": "non-const call in a const/static.\nfix: use `const fn`, `std::sync::OnceLock` / `LazyLock` for runtime init.",
    "E0658": "unstable feature used.\nfix: rewrite with stable APIs for the pinned toolchain; do not switch to nightly.",
    "E0728": "`await` outside async.\nfix: make the fn `async` (and its callers), or block via the runtime at the top level only.",
    "E0746": "return type `dyn Trait` has no known size.\nfix: `impl Trait` (one concrete type) or `Box<dyn Trait>`.",
    "E0495": "lifetime conflict (older rustc; now E0521/E0759 variants).\n"
             "fix: add explicit lifetimes linking input and output; avoid storing borrowed data in 'static contexts.",
    "E0521": "borrowed data escapes the function (e.g. into thread::spawn or a 'static box).\n"
             "fix: pass owned data / Arc, or require `T: 'static`.",
    "clippy::needless_range_loop": "use `for (i, x) in v.iter().enumerate()` or iterate directly.",
    "clippy::redundant_clone": "drop the `.clone()`; the value is not used afterwards.",
    "clippy::unwrap_used": "replace unwrap with `?`, `expect(\"why\")` for invariants, or handle None/Err.",
    "clippy::too_many_arguments": "group parameters into a struct; or `#[allow]` if the project does so elsewhere.",
    "clippy::large_enum_variant": "Box the large variant's payload.",
    "clippy::collapsible_if": "merge nested ifs with `&&` (or `if let ... && ...` on edition 2024).",
}


def main(argv):
    if not argv or "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    if "--list" in argv:
        print(" ".join(sorted(R)))
        return 0
    out = []
    for code in argv:
        c = code.strip().strip("[]")
        key = c.upper() if c.upper().startswith("E") and c[1:].isdigit() else c
        if key in R:
            out.append("%s: %s" % (key, R[key]))
            continue
        try:
            p = subprocess.run(["rustc", "--explain", key], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, universal_newlines=True, timeout=20)
            text = [ln for ln in p.stdout.splitlines() if ln.strip()][:12]
            out.append("%s (from rustc --explain):" % key if text else "%s: unknown code" % key)
            out += ["  " + ln[:150] for ln in text]
        except (OSError, subprocess.TimeoutExpired):
            out.append("%s: not in this table and rustc is unavailable" % key)
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
