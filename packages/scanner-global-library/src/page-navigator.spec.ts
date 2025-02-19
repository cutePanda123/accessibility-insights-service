// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import 'reflect-metadata';

import { IMock, Mock, It } from 'typemoq';
import { Page, HTTPResponse } from 'puppeteer';
import { PageResponseProcessor } from './page-response-processor';
import { PageNavigator } from './page-navigator';
import { BrowserError } from './browser-error';
import { PageNavigationHooks } from './page-navigation-hooks';
import { PageConfigurator } from './page-configurator';
import { puppeteerTimeoutConfig } from './page-timeout-config';
import { MockableLogger } from './test-utilities/mockable-logger';
import { PageConfigurationOptions } from './page';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */

const url = 'url';

let pageNavigator: PageNavigator;
let pageResponseProcessorMock: IMock<PageResponseProcessor>;
let navigationHooksMock: IMock<PageNavigationHooks>;
let puppeteerPageMock: IMock<Page>;
let loggerMock: IMock<MockableLogger>;
let timingCount: number;
let pageConfigurationOptions: PageConfigurationOptions;

describe(PageNavigator, () => {
    beforeEach(() => {
        pageResponseProcessorMock = Mock.ofType<PageResponseProcessor>();
        navigationHooksMock = Mock.ofType<PageNavigationHooks>();
        puppeteerPageMock = Mock.ofType<Page>();
        loggerMock = Mock.ofType(MockableLogger);

        timingCount = 0;
        process.hrtime = {
            bigint: () => {
                timingCount += 1;

                return BigInt(timingCount * 10000000000);
            },
        } as NodeJS.HRTime;
        pageConfigurationOptions = {
            allowCachedVersion: false,
        };

        pageNavigator = new PageNavigator(pageResponseProcessorMock.object, navigationHooksMock.object, loggerMock.object);
    });

    afterEach(() => {
        pageResponseProcessorMock.verifyAll();
        navigationHooksMock.verifyAll();
        puppeteerPageMock.verifyAll();
        loggerMock.verifyAll();
    });

    it('get pageConfigurator', () => {
        const pageConfiguratorMock = Mock.ofType<PageConfigurator>();
        navigationHooksMock.setup((o) => o.pageConfigurator).returns(() => pageConfiguratorMock.object);

        expect(pageNavigator.pageConfigurator).toBe(pageConfiguratorMock.object);
    });

    it('reload with success', async () => {
        const response = {
            status: () => 200,
        } as unknown as HTTPResponse;
        const onNavigationErrorMock = jest.fn();

        puppeteerPageMock
            .setup(async (o) =>
                o.reload({
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.evaluate(It.isAny()))
            .returns(() => Promise.resolve())
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.waitForNavigation({ waitUntil: 'networkidle0', timeout: puppeteerTimeoutConfig.networkIdleTimeoutMsec }))
            .returns(() => Promise.resolve(undefined))
            .verifiable();
        navigationHooksMock.setup((o) => o.postNavigation(puppeteerPageMock.object, response, onNavigationErrorMock)).verifiable();

        const pageTiming = await pageNavigator.reload(puppeteerPageMock.object, onNavigationErrorMock);
        expect(onNavigationErrorMock).toBeCalledTimes(0);
        expect(pageTiming).toEqual({
            httpResponse: response,
            pageNavigationTiming: {
                goto1: 10000,
                goto1Timeout: false,
                goto2: 0,
                networkIdle: 10000,
                networkIdleTimeout: false,
            },
        });
    });

    it('reload with success if receive HTTP 304', async () => {
        const response = {
            status: () => 304,
        } as unknown as HTTPResponse;
        const onNavigationErrorMock = jest.fn();

        puppeteerPageMock
            .setup(async (o) =>
                o.reload({
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup(async (o) => o.goto(`file:///${__dirname}/blank-page.html`))
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup(async (o) =>
                o.goBack({
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.evaluate(It.isAny()))
            .returns(() => Promise.resolve())
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.waitForNavigation({ waitUntil: 'networkidle0', timeout: puppeteerTimeoutConfig.networkIdleTimeoutMsec }))
            .returns(() => Promise.resolve(undefined))
            .verifiable();
        navigationHooksMock.setup((o) => o.postNavigation(puppeteerPageMock.object, response, onNavigationErrorMock)).verifiable();

        const pageTiming = await pageNavigator.reload(puppeteerPageMock.object, onNavigationErrorMock);
        expect(onNavigationErrorMock).toBeCalledTimes(0);
        expect(pageTiming).toEqual({
            httpResponse: response,
            pageNavigationTiming: {
                goto1: 10000,
                goto1Timeout: false,
                goto2: 0,
                networkIdle: 10000,
                networkIdleTimeout: false,
            },
        });
    });

    it('reload with browser error', async () => {
        const error = new Error('navigation error');
        const browserError = {
            errorType: 'NavigationError',
            message: 'navigation error',
        } as BrowserError;
        puppeteerPageMock
            .setup(async (o) =>
                o.reload({
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.reject(error))
            .verifiable();
        pageResponseProcessorMock
            .setup((o) => o.getNavigationError(error))
            .returns(() => browserError)
            .verifiable();
        const onNavigationErrorMock = jest.fn();
        onNavigationErrorMock.mockImplementation((browserErr, err) => Promise.resolve());

        await pageNavigator.reload(puppeteerPageMock.object, onNavigationErrorMock);
        expect(onNavigationErrorMock).toHaveBeenCalledWith(browserError, error);
    });

    it('reload with network idle wait error', async () => {
        const response = {
            status: () => 200,
        } as HTTPResponse;
        const onNavigationErrorMock = jest.fn();

        puppeteerPageMock
            .setup(async (o) =>
                o.reload({
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.evaluate(It.isAny()))
            .returns(() => Promise.resolve())
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.waitForNavigation({ waitUntil: 'networkidle0', timeout: puppeteerTimeoutConfig.networkIdleTimeoutMsec }))
            .returns(() => Promise.reject('waitForNavigation() error'))
            .verifiable();
        navigationHooksMock.setup((o) => o.postNavigation(puppeteerPageMock.object, response, onNavigationErrorMock)).verifiable();

        const pageTiming = await pageNavigator.reload(puppeteerPageMock.object, onNavigationErrorMock);
        expect(onNavigationErrorMock).toBeCalledTimes(0);
        expect(pageTiming).toEqual({
            httpResponse: response,
            pageNavigationTiming: {
                goto1: 10000,
                goto1Timeout: false,
                goto2: 0,
                networkIdle: 10000,
                networkIdleTimeout: true,
            },
        });
    });

    it('navigate with success', async () => {
        const response = {} as HTTPResponse;
        const onNavigationErrorMock = jest.fn();

        puppeteerPageMock
            .setup(async (o) =>
                o.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.evaluate(It.isAny()))
            .returns(() => Promise.resolve())
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.waitForNavigation({ waitUntil: 'networkidle0', timeout: puppeteerTimeoutConfig.networkIdleTimeoutMsec }))
            .returns(() => Promise.resolve(undefined))
            .verifiable();
        navigationHooksMock.setup((o) => o.preNavigation(puppeteerPageMock.object)).verifiable();
        navigationHooksMock.setup((o) => o.postNavigation(puppeteerPageMock.object, response, onNavigationErrorMock)).verifiable();

        const pageTiming = await pageNavigator.navigate(url, puppeteerPageMock.object, pageConfigurationOptions, onNavigationErrorMock);
        expect(onNavigationErrorMock).toBeCalledTimes(0);
        expect(pageTiming).toEqual({
            httpResponse: response,
            pageNavigationTiming: {
                goto1: 10000,
                goto1Timeout: false,
                goto2: 0,
                networkIdle: 10000,
                networkIdleTimeout: false,
            },
        });
    });

    it('navigate with network idle wait error', async () => {
        const response = {} as HTTPResponse;
        const onNavigationErrorMock = jest.fn();

        puppeteerPageMock
            .setup(async (o) =>
                o.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.evaluate(It.isAny()))
            .returns(() => Promise.resolve())
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.waitForNavigation({ waitUntil: 'networkidle0', timeout: puppeteerTimeoutConfig.networkIdleTimeoutMsec }))
            .returns(() => Promise.reject('waitForNavigation() error'))
            .verifiable();
        navigationHooksMock.setup((o) => o.preNavigation(puppeteerPageMock.object)).verifiable();
        navigationHooksMock.setup((o) => o.postNavigation(puppeteerPageMock.object, response, onNavigationErrorMock)).verifiable();

        const pageTiming = await pageNavigator.navigate(url, puppeteerPageMock.object, pageConfigurationOptions, onNavigationErrorMock);
        expect(onNavigationErrorMock).toBeCalledTimes(0);
        expect(pageTiming).toEqual({
            httpResponse: response,
            pageNavigationTiming: {
                goto1: 10000,
                goto1Timeout: false,
                goto2: 0,
                networkIdle: 10000,
                networkIdleTimeout: true,
            },
        });
    });

    it('navigate with browser error', async () => {
        const error = new Error('navigation error');
        const browserError = {
            errorType: 'NavigationError',
            message: 'navigation error',
        } as BrowserError;
        puppeteerPageMock
            .setup(async (o) =>
                o.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.reject(error))
            .verifiable();
        navigationHooksMock.setup((o) => o.preNavigation(puppeteerPageMock.object)).verifiable();
        pageResponseProcessorMock
            .setup((o) => o.getNavigationError(error))
            .returns(() => browserError)
            .verifiable();
        const onNavigationErrorMock = jest.fn();
        onNavigationErrorMock.mockImplementation((browserErr, err) => Promise.resolve());

        await pageNavigator.navigate(url, puppeteerPageMock.object, pageConfigurationOptions, onNavigationErrorMock);
        expect(onNavigationErrorMock).toHaveBeenCalledWith(browserError, error);
    });

    it('navigate with browser UrlNavigationTimeout() error', async () => {
        const response = {} as HTTPResponse;
        const error = new Error('navigation timeout');
        const browserError = {
            errorType: 'UrlNavigationTimeout',
            message: 'navigation timeout',
        } as BrowserError;
        puppeteerPageMock
            .setup(async (o) =>
                o.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.reject(error))
            .verifiable();
        puppeteerPageMock
            .setup(async (o) =>
                o.goto(url, {
                    waitUntil: 'load',
                    timeout: puppeteerTimeoutConfig.navigationTimeoutMsecs,
                }),
            )
            .returns(() => Promise.resolve(response))
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.evaluate(It.isAny()))
            .returns(() => Promise.resolve())
            .verifiable();
        puppeteerPageMock
            .setup((o) => o.waitForNavigation({ waitUntil: 'networkidle0', timeout: puppeteerTimeoutConfig.networkIdleTimeoutMsec }))
            .returns(() => Promise.resolve(undefined))
            .verifiable();
        pageResponseProcessorMock
            .setup((o) => o.getNavigationError(error))
            .returns(() => browserError)
            .verifiable();

        const onNavigationErrorMock = jest.fn();
        navigationHooksMock.setup((o) => o.preNavigation(puppeteerPageMock.object)).verifiable();
        navigationHooksMock.setup((o) => o.postNavigation(puppeteerPageMock.object, response, onNavigationErrorMock)).verifiable();

        const pageTiming = await pageNavigator.navigate(url, puppeteerPageMock.object, pageConfigurationOptions, onNavigationErrorMock);
        expect(onNavigationErrorMock).toBeCalledTimes(0);
        expect(pageTiming).toEqual({
            httpResponse: {},
            pageNavigationTiming: {
                goto1: 10000,
                goto1Timeout: true,
                goto2: 10000,
                networkIdle: 10000,
                networkIdleTimeout: false,
            },
        });
    });
});
