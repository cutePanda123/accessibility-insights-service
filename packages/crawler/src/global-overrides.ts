// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export {};

/* eslint-disable @typescript-eslint/no-explicit-any, , @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
function overrideCheckPrototypeUtilsFunc(exports: any): any {
    const originalFunc = exports.checkParamPrototypeOrThrow;
    Reflect.set(
        exports,
        'checkParamPrototypeOrThrow',
        function (...args: any): any {
            if (args[3] === 'Apify.RequestQueue') {
                return true;
            } else {
                return originalFunc(...args);
            }
        },
        exports,
    );

    return exports;
}

function overrideExports(moduleName: string, exports: any): any {
    if (moduleName === '@apify/utilities') {
        return overrideCheckPrototypeUtilsFunc(exports);
    }

    return exports;
}

const moduleRef = require('module');
moduleRef.prototype.require = new Proxy(moduleRef.prototype.require, {
    apply(target: any, thisArg: any, argumentsList: any): any {
        const moduleName = argumentsList[0];
        const exports = Reflect.apply(target, thisArg, argumentsList);

        return overrideExports(moduleName, exports);
    },
});

moduleRef._resolveFilename = new Proxy(moduleRef._resolveFilename, {
    apply(target: any, thisArg: any, argumentsList: any): any {
        const moduleName = argumentsList[0] as string;
        let path = Reflect.apply(target, thisArg, argumentsList) as string;
        if (moduleName.indexOf('@uifabric/styling') >= 0) {
            path = fixModulePath('@uifabric', path);
        }

        return path;
    },
});

function fixModulePath(moduleName: string, path: string): string {
    // fix path of the package content only
    const index = path.lastIndexOf(moduleName);
    if (require('os').type() === 'Windows_NT') {
        return path.slice(0, index) + path.slice(index).replace('\\lib\\', '\\lib-commonjs\\');
    } else {
        return path.slice(0, index) + path.slice(index).replace('/lib/', '/lib-commonjs/');
    }
}
