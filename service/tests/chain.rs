//! The chain under wasmtime, through the same `Chain` the live engine uses.
//! The browser side of the same checks is `scripts/test-chain.ts`.

use tonecraft_engine::chain::{Chain, Compiler};

const RATE: f32 = 48_000.0;
const BLOCK: usize = 128;

fn chain() -> Chain {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../public/dsp/chain.wasm");
    let bytes = std::fs::read(path).expect("public/dsp/chain.wasm: run `npm run build:dsp`");
    let mut compiler = Compiler::new().unwrap();
    let module = compiler.compile(&bytes).unwrap();
    Chain::new(compiler.engine(), &module, RATE, BLOCK).unwrap()
}

fn call(chain: &mut Chain, name: &str, args: &[f64], payload: Option<&[u8]>) -> f64 {
    let index = chain
        .export_index(name)
        .unwrap_or_else(|| panic!("no export {name}"));
    chain.call(index, args, payload).unwrap()
}

fn run(chain: &mut Chain, x: &[f32]) -> Vec<f32> {
    let mut y = Vec::with_capacity(x.len());
    for block in x.chunks(BLOCK) {
        chain.inputs_mut().0[..block.len()].copy_from_slice(block);
        chain.process(block.len(), 1);
        y.extend_from_slice(&chain.output()[..block.len()]);
    }
    y
}

#[test]
fn abi_and_zero_latency() {
    let mut c = chain();
    assert_eq!(call(&mut c, "tc_abi_version", &[], None), 1.0);

    // Neutral, as in scripts/test-chain.ts: every stage out of the way but the
    // linear ones, and a unit cabinet.
    for (index, value) in [
        (0.0, 0.0),
        (2.0, 1.0),
        (6.0, 1.0),
        (23.0, 1.0),
        (16.0, 1.0),
        (17.0, 0.0),
    ] {
        call(&mut c, "tc_set_param", &[index, value], None);
    }
    call(&mut c, "tc_set_ir", &[0.0], Some(&1.0f32.to_le_bytes()));
    // Every parameter glides where it is sent; half a second to arrive.
    run(&mut c, &vec![0.0; RATE as usize / 2]);

    let mut x = vec![0.0f32; 4096];
    x[1000] = 0.25;
    let y = run(&mut c, &x);
    assert!(y.iter().all(|v| v.is_finite()));
    let peak = (0..y.len())
        .max_by(|&a, &b| y[a].abs().total_cmp(&y[b].abs()))
        .unwrap();
    assert_eq!(peak, 1000, "the chain must add no latency of its own");
    assert!(!c.dead());
}

#[test]
fn refuses_what_it_cannot_call() {
    let mut c = chain();
    assert!(c.export_index("tc_process").is_some());
    assert!(
        c.export_index("malloc").is_none(),
        "only tc_* exports are callable"
    );
    let set = c.export_index("tc_set_param").unwrap();
    assert!(
        c.call(set, &[1.0], None).is_err(),
        "a wrong argument count is refused"
    );
}
