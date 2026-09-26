import * as commander from '../index.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function makeProgram() {
  const errors = [];
  const program = new commander.Command();
  program.exitOverride().configureOutput({
    writeErr: (str) => errors.push(str),
    writeOut: () => {},
  });
  return { program, errors };
}

describe('Option.deprecated()', () => {
  test('returns the option and records the message', () => {
    const option = new commander.Option('--old <value>');
    assert.equal(option.isDeprecated, false);
    assert.equal(option.deprecated('use --new'), option);
    assert.equal(option.isDeprecated, true);
    assert.equal(option.deprecationMessage, 'use --new');
  });

  test('message is optional', () => {
    const option = new commander.Option('--old').deprecated();
    assert.equal(option.isDeprecated, true);
    assert.equal(option.deprecationMessage, '');
  });

  test('help shows deprecated without message', () => {
    const option = new commander.Option('--old', 'old flag').deprecated();
    assert.equal(new commander.Help().optionDescription(option), 'old flag (deprecated)');
  });

  test('help shows deprecated last with message', () => {
    const option = new commander.Option('-c, --colour <name>', 'output colour').default('auto').deprecated('use --color');
    assert.equal(
      new commander.Help().optionDescription(option),
      'output colour (default: "auto", deprecated: use --color)',
    );
  });

  test('help for option without description', () => {
    const option = new commander.Option('--old').deprecated('gone');
    assert.equal(new commander.Help().optionDescription(option), '(deprecated: gone)');
  });

  test('using the long flag warns with the message and still sets the value', () => {
    const { program, errors } = makeProgram();
    program.addOption(new commander.Option('-c, --colour <name>').deprecated('use --color'));
    program.parse(['--colour', 'red'], { from: 'user' });
    assert.equal(program.opts().colour, 'red');
    assert.deepEqual(errors, ["warning: option '-c, --colour <name>' is deprecated: use --color\n"]);
  });

  test('using the short flag warns without message', () => {
    const { program, errors } = makeProgram();
    program.addOption(new commander.Option('-q, --quiet').deprecated());
    program.parse(['-q'], { from: 'user' });
    assert.equal(program.opts().quiet, true);
    assert.deepEqual(errors, ["warning: option '-q, --quiet' is deprecated\n"]);
  });

  test('not using the option does not warn', () => {
    const { program, errors } = makeProgram();
    program.addOption(new commander.Option('--old').deprecated());
    program.option('--other');
    program.parse(['--other'], { from: 'user' });
    assert.deepEqual(errors, []);
  });

  test('defaults and env values do not warn', () => {
    const { program, errors } = makeProgram();
    program.addOption(new commander.Option('--level <n>').default('1').deprecated());
    program.addOption(new commander.Option('--mode <m>').env('HIDDEN_TEST_MODE').deprecated());
    process.env.HIDDEN_TEST_MODE = 'fast';
    try {
      program.parse([], { from: 'user' });
    } finally {
      delete process.env.HIDDEN_TEST_MODE;
    }
    assert.equal(program.opts().level, '1');
    assert.equal(program.opts().mode, 'fast');
    assert.deepEqual(errors, []);
  });

  test('warning goes to subcommand output', () => {
    const { program, errors } = makeProgram();
    let seen;
    program
      .command('run')
      .addOption(new commander.Option('--fast').deprecated('it is always fast'))
      .action((options) => {
        seen = options.fast;
      });
    program.parse(['run', '--fast'], { from: 'user' });
    assert.equal(seen, true);
    assert.deepEqual(errors, ["warning: option '--fast' is deprecated: it is always fast\n"]);
  });

  test('non-deprecated options behave as before', () => {
    const { program, errors } = makeProgram();
    program.option('--new <v>');
    program.parse(['--new', 'x'], { from: 'user' });
    assert.equal(program.opts().new, 'x');
    assert.deepEqual(errors, []);
  });
});
