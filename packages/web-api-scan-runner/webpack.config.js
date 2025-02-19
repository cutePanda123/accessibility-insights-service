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
        externals: [
            'puppeteer',
            'yargs',
            'axe-core',
            '@axe-core/puppeteer',
            'applicationinsights',
            'accessibility-insights-report',
            'apify',
            'leveldown',
            'puppeteer-extra',
            'puppeteer-extra-plugin',
            'puppeteer-extra-plugin-stealth',
        ],
        entry: {
            ['web-api-scan-runner']: path.resolve('./src/index.ts'),
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
        name: 'web-api-scan-runner',
        node: {
            __dirname: false,
        },
        output: {
            path: path.resolve('./dist'),
            filename: '[name].js',
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
                        context: './docker-image-config',
                        from: '.dockerignore',
                        to: '',
                    },
                    {
                        context: './docker-image-config',
                        from: 'Dockerfile',
                        to: '',
                    },
                    {
                        context: './docker-image-config',
                        from: 'web-api-scan-runner.ps1',
                        to: '',
                    },
                    {
                        context: '../../packages/parallel-workers/dist',
                        from: '**/*.js',
                        to: '',
                    },
                ],
            }),
        ],
        resolve: {
            extensions: ['.ts', '.js', '.json'],
            mainFields: ['main'],
        },
        target: 'node',
    };
};
