/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+metro_bundler
 * @flow
 * @format
 */

'use strict';

const babylon = require('@babel/parser');
const collectDependencies = require('../collectDependencies');
const dedent = require('dedent');

const {codeFromAst, comparableCode} = require('../../test-helpers');
const {codeFrameColumns} = require('@babel/code-frame');

const {any, objectContaining} = expect;

const {InvalidRequireCallError} = collectDependencies;
const opts = {
  asyncRequireModulePath: 'asyncRequire',
  dynamicRequires: 'reject',
  inlineableCalls: [],
  keepRequireNames: true,
};

it('collects unique dependency identifiers and transforms the AST', () => {
  const ast = astFromCode(`
    const a = require('b/lib/a');
    exports.do = () => require("do");
    if (!something) {
      require("setup/something");
    }
    require('do');
  `);
  const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'b/lib/a', data: objectContaining({isAsync: false})},
    {name: 'do', data: objectContaining({isAsync: false})},
    {name: 'setup/something', data: objectContaining({isAsync: false})},
  ]);
  expect(codeFromAst(ast)).toEqual(
    comparableCode(`
      const a = require(${dependencyMapName}[0], "b/lib/a");
      exports.do = () => require(${dependencyMapName}[1], "do");
      if (!something) {
        require(${dependencyMapName}[2], "setup/something");
      }
      require(${dependencyMapName}[1], "do");
    `),
  );
});

it('collects asynchronous dependencies', () => {
  const ast = astFromCode(`
    import("some/async/module").then(foo => {});
  `);
  const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'some/async/module', data: objectContaining({isAsync: true})},
    {name: 'asyncRequire', data: objectContaining({isAsync: false})},
  ]);
  expect(codeFromAst(ast)).toEqual(
    comparableCode(`
      require(${dependencyMapName}[1], "asyncRequire")(${dependencyMapName}[0], "some/async/module").then(foo => {});
    `),
  );
});

it('collects mixed dependencies as being sync', () => {
  const ast = astFromCode(`
    const a = require("some/async/module");
    import("some/async/module").then(foo => {});
  `);
  const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'some/async/module', data: objectContaining({isAsync: false})},
    {name: 'asyncRequire', data: objectContaining({isAsync: false})},
  ]);
  expect(codeFromAst(ast)).toEqual(
    comparableCode(`
      const a = require(${dependencyMapName}[0], "some/async/module");
      require(${dependencyMapName}[1], "asyncRequire")(${dependencyMapName}[0], "some/async/module").then(foo => {});
    `),
  );
});

it('collects mixed dependencies as being sync; reverse order', () => {
  const ast = astFromCode(`
    import("some/async/module").then(foo => {});
    const a = require("some/async/module");
  `);
  const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'some/async/module', data: objectContaining({isAsync: false})},
    {name: 'asyncRequire', data: objectContaining({isAsync: false})},
  ]);
  expect(codeFromAst(ast)).toEqual(
    comparableCode(`
      require(${dependencyMapName}[1], "asyncRequire")(${dependencyMapName}[0], "some/async/module").then(foo => {});
      const a = require(${dependencyMapName}[0], "some/async/module");
    `),
  );
});

it('collects __jsResource calls', () => {
  const ast = astFromCode(`
    __jsResource("some/async/module");
  `);
  const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'some/async/module', data: objectContaining({isAsync: true})},
    {name: 'asyncRequire', data: objectContaining({isAsync: false})},
  ]);
  expect(codeFromAst(ast)).toEqual(
    comparableCode(`
      require(${dependencyMapName}[1], "asyncRequire").resource(${dependencyMapName}[0], "some/async/module");
    `),
  );
});

it('collects conditionallySplitJSResource calls', () => {
  const ast = astFromCode(`
    __conditionallySplitJSResource("some/async/module", {mobileConfigName: 'aaa'});
    __conditionallySplitJSResource("some/async/module", {mobileConfigName: 'bbb'});
  `);
  const {dependencies} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'some/async/module', data: objectContaining({isAsync: true})},
    {name: 'asyncRequire', data: objectContaining({isAsync: false})},
  ]);
});

describe('import() prefetching', () => {
  it('collects prefetch calls', () => {
    const ast = astFromCode(`
      __prefetchImport("some/async/module");
    `);
    const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {
        name: 'some/async/module',
        data: objectContaining({isAsync: true, isPrefetchOnly: true}),
      },
      {name: 'asyncRequire', data: objectContaining({isAsync: false})},
    ]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(`
        require(${dependencyMapName}[1], "asyncRequire").prefetch(${dependencyMapName}[0], "some/async/module");
      `),
    );
  });

  it('disable prefetch-only flag for mixed import/prefetch calls', () => {
    const ast = astFromCode(`
      __prefetchImport("some/async/module");
      import("some/async/module").then(() => {});
    `);
    const {dependencies} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {name: 'some/async/module', data: objectContaining({isAsync: true})},
      {name: 'asyncRequire', data: objectContaining({isAsync: false})},
    ]);
  });
});

describe('Evaluating static arguments', () => {
  it('supports template literals as arguments', () => {
    const ast = astFromCode('require(`left-pad`)');
    const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {name: 'left-pad', data: objectContaining({isAsync: false})},
    ]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(`require(${dependencyMapName}[0], "left-pad");`),
    );
  });

  it('supports template literals with static interpolations', () => {
    const ast = astFromCode('require(`left${"-"}pad`)');
    const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {name: 'left-pad', data: objectContaining({isAsync: false})},
    ]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(`require(${dependencyMapName}[0], "left-pad");`),
    );
  });

  it('throws template literals with dyncamic interpolations', () => {
    const ast = astFromCode('let foo;require(`left${foo}pad`)');
    try {
      collectDependencies(ast, opts);
      throw new Error('should not reach');
    } catch (error) {
      if (!(error instanceof InvalidRequireCallError)) {
        throw error;
      }
      expect(error.message).toMatchSnapshot();
    }
  });

  it('throws on tagged template literals', () => {
    const ast = astFromCode('require(tag`left-pad`)');
    try {
      collectDependencies(ast, opts);
      throw new Error('should not reach');
    } catch (error) {
      if (!(error instanceof InvalidRequireCallError)) {
        throw error;
      }
      expect(error.message).toMatchSnapshot();
    }
  });

  it('supports multiple static strings concatenated', () => {
    const ast = astFromCode('require("foo_" + "bar")');
    const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {name: 'foo_bar', data: objectContaining({isAsync: false})},
    ]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(`require(${dependencyMapName}[0], "foo_bar");`),
    );
  });

  it('supports concatenating strings and template literasl', () => {
    const ast = astFromCode('require("foo_" + "bar" + `_baz`)');
    const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {name: 'foo_bar_baz', data: objectContaining({isAsync: false})},
    ]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(`require(${dependencyMapName}[0], "foo_bar_baz");`),
    );
  });

  it('supports using static variables in require statements', () => {
    const ast = astFromCode('const myVar="my";require("foo_" + myVar)');
    const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([
      {name: 'foo_my', data: objectContaining({isAsync: false})},
    ]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(
        `const myVar = \"my\"; require(${dependencyMapName}[0], "foo_my");`,
      ),
    );
  });

  it('throws when requiring non-strings', () => {
    const ast = astFromCode('require(1)');
    try {
      collectDependencies(ast, opts);
      throw new Error('should not reach');
    } catch (error) {
      if (!(error instanceof InvalidRequireCallError)) {
        throw error;
      }
      expect(error.message).toMatchSnapshot();
    }
  });

  it('throws at runtime when requiring non-strings with special option', () => {
    const ast = astFromCode('require(1)');
    const opts = {
      asyncRequireModulePath: 'asyncRequire',
      dynamicRequires: 'throwAtRuntime',
      inlineableCalls: [],
      keepRequireNames: true,
    };
    const {dependencies} = collectDependencies(ast, opts);
    expect(dependencies).toEqual([]);
    expect(codeFromAst(ast)).toEqual(
      comparableCode(`
        (function (line) {
          throw new Error('Dynamic require defined at line ' + line + '; not supported by Metro');
        })(1);
      `),
    );
  });
});

it('exposes a string as `dependencyMapName` even without collecting dependencies', () => {
  const ast = astFromCode('');
  expect(collectDependencies(ast, opts).dependencyMapName).toEqual(any(String));
});

it('ignores require functions defined defined by lower scopes', () => {
  const ast = astFromCode(`
    const a = require('b/lib/a');
    exports.do = () => require("do");
    if (!something) {
      require("setup/something");
    }
    require('do');
    function testA(require) {
      const b = require('nonExistantModule');
    }
    {
      const require = function(foo) {
        return;
      }
      require('nonExistantModule');
    }
  `);
  const {dependencies, dependencyMapName} = collectDependencies(ast, opts);
  expect(dependencies).toEqual([
    {name: 'b/lib/a', data: objectContaining({isAsync: false})},
    {name: 'do', data: objectContaining({isAsync: false})},
    {name: 'setup/something', data: objectContaining({isAsync: false})},
  ]);
  expect(codeFromAst(ast)).toEqual(
    comparableCode(`
      const a = require(${dependencyMapName}[0], "b/lib/a");
      exports.do = () => require(${dependencyMapName}[1], "do");
      if (!something) {
        require(${dependencyMapName}[2], "setup/something");
      }
      require(${dependencyMapName}[1], "do");
      function testA(require) {
        const b = require('nonExistantModule');
      }
      {
        const require = function (foo) { return; };
        require('nonExistantModule');
      }
    `),
  );
});

it('collects imports', () => {
  const ast = astFromCode(`
    import b from 'b/lib/a';
    import * as d from 'do';
    import type {s} from 'setup/something';
  `);

  const {dependencies} = collectDependencies(ast, opts);

  expect(dependencies).toEqual([
    {name: 'b/lib/a', data: objectContaining({isAsync: false})},
    {name: 'do', data: objectContaining({isAsync: false})},
    {name: 'setup/something', data: objectContaining({isAsync: false})},
  ]);
});

it('records locations of dependencies', () => {
  const code = dedent`
    import b from 'b/lib/a';
    import * as d from 'do';
    import type {s} from 'setup/something';
    import('some/async/module').then(foo => {});
    __jsResource('some/async/module');
    __conditionallySplitJSResource('some/async/module', {mobileConfigName: 'aaa'});
    __conditionallySplitJSResource('some/async/module', {mobileConfigName: 'bbb'});
    require('foo'); __prefetchImport('baz');
  `;
  const ast = astFromCode(code);

  const {dependencies} = collectDependencies(ast, opts);

  for (const dep of dependencies) {
    expect(dep).toEqual(
      objectContaining({data: objectContaining({locs: any(Array)})}),
    );
  }
  expect(formatDependencyLocs(dependencies, code)).toMatchInlineSnapshot(`
    "
    > 1 | import b from 'b/lib/a';
        | ^^^^^^^^^^^^^^^^^^^^^^^^ dep #0
    > 2 | import * as d from 'do';
        | ^^^^^^^^^^^^^^^^^^^^^^^^ dep #1
    > 3 | import type {s} from 'setup/something';
        | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ dep #2
    > 4 | import('some/async/module').then(foo => {});
        | ^^^^^^^^^^^^^^^^^^^^^^^^^^^ dep #3
    > 5 | __jsResource('some/async/module');
        | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ dep #3
    > 6 | __conditionallySplitJSResource('some/async/module', {mobileConfigName: 'aaa'});
        | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ dep #3
    > 7 | __conditionallySplitJSResource('some/async/module', {mobileConfigName: 'bbb'});
        | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ dep #3
    dep #4 (asyncRequire): no location recorded
    > 8 | require('foo'); __prefetchImport('baz');
        | ^^^^^^^^^^^^^^ dep #5
    > 8 | require('foo'); __prefetchImport('baz');
        |                 ^^^^^^^^^^^^^^^^^^^^^^^ dep #6"
  `);
});

function formatDependencyLocs(dependencies, code) {
  return (
    '\n' +
    dependencies
      .map((dep, depIndex) =>
        dep.data.locs.length
          ? dep.data.locs.map(loc => formatLoc(loc, depIndex, code)).join('\n')
          : `dep #${depIndex} (${dep.name}): no location recorded`,
      )
      .join('\n')
  );
}

function adjustPosForCodeFrame(pos) {
  return pos ? {...pos, column: pos.column + 1} : pos;
}

function adjustLocForCodeFrame(loc) {
  return {
    start: adjustPosForCodeFrame(loc.start),
    end: adjustPosForCodeFrame(loc.end),
  };
}

function formatLoc(loc, depIndex, code) {
  return codeFrameColumns(code, adjustLocForCodeFrame(loc), {
    message: `dep #${depIndex}`,
    linesAbove: 0,
    linesBelow: 0,
  });
}

function astFromCode(code: string) {
  return babylon.parse(code, {
    plugins: ['dynamicImport', 'flow'],
    sourceType: 'module',
  });
}
