// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const path = require('path');
const webpack = require('webpack');
const forkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const copyWebpackPlugin = require('copy-webpack-plugin');
const ignoreDynamicRequire = require('webpack-ignore-dynamic-require');

module.exports = (env) => {
    const version = env ? env.version : 'dev';
    console.log(`Building for version : ${version}`);

    return {
        devtool: 'cheap-source-map',
        externals: ['@azure/functions'],
        entry: {
            ['scan-batch-requests-feed-func']: path.resolve('./scan-batch-requests-feed-func/index.ts'),
            ['health-monitor-timer-func']: path.resolve('./health-monitor-timer-func/index.ts'),
            ['health-monitor-client-func']: path.resolve('./health-monitor-client-func/index.ts'),
            ['health-monitor-orchestration-func']: path.resolve('./health-monitor-orchestration-func/index.ts'),
        },
        mode: 'development',
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: [
                        {
                            loader: 'ts-loader',
                            options: {
                                transpileOnly: true,
                                experimentalWatchApi: true,
                            },
                        },
                    ],
                    exclude: ['/node_modules/', /\.(spec|e2e)\.ts$/],
                },
                {
                    test: /\.node$/,
                    use: [
                        {
                            loader: 'node-loader',
                        },
                    ],
                },
            ],
        },
        name: 'web-workers',
        node: {
            __dirname: false,
        },
        output: {
            path: path.resolve('./dist'),
            filename: '[name]/index.js',
            libraryTarget: 'commonjs2',
        },
        plugins: [
            new webpack.DefinePlugin({
                __IMAGE_VERSION__: JSON.stringify(version),
            }),
            new forkTsCheckerWebpackPlugin(),
            new ignoreDynamicRequire(),
            new copyWebpackPlugin({
                patterns: [
                    {
                        context: './',
                        from: '**/function.json',
                        to: '',
                        globOptions: { ignore: ['dist/**'] },
                    },
                    {
                        context: './',
                        from: 'host.json',
                        to: '',
                        globOptions: { ignore: ['dist/**'] },
                    },
                    {
                        from: 'package.json',
                        to: '',
                    },
                    {
                        from: '*.csproj',
                        to: '',
                    },
                    {
                        from: '../../yarn.lock',
                        to: '',
                    },
                    {
                        context: '../parallel-workers/dist/',
                        from: '**/*.js',
                        to: '',
                    },
                    {
                        context: '../parallel-workers/dist/',
                        from: '**/*.js',
                        to: 'health-monitor-client-func',
                    },
                    {
                        context: '../parallel-workers/dist/',
                        from: '**/*.js',
                        to: 'health-monitor-orchestration-func',
                    },
                    {
                        context: '../parallel-workers/dist/',
                        from: '**/*.js',
                        to: 'health-monitor-timer-func',
                    },
                    {
                        context: '../parallel-workers/dist/',
                        from: '**/*.js',
                        to: 'scan-batch-requests-feed-func',
                    },
                ],
            }),
        ],
        resolve: {
            extensions: ['.ts', '.js', '.json'],
        },
        target: 'node',
    };
};
