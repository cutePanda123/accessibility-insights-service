// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { PrivacyScanConfig, ServiceConfiguration, System } from 'common';
import { inject, injectable, optional } from 'inversify';
import { ConsentResult } from 'storage-documents';
import { GlobalLogger } from 'logger';
import { Page } from 'scanner-global-library';
import { CookieScenario, getAllCookieScenarios } from './cookie-scenarios';
import { CookieCollector } from './cookie-collector';
import { PrivacyResults } from './privacy-results';
import { IpGeolocationProvider } from './ip-geolocation-provider';

@injectable()
export class PrivacyScenarioRunner {
    constructor(
        @inject(ServiceConfiguration) private readonly serviceConfig: ServiceConfiguration,
        @inject(CookieCollector) private readonly cookieCollector: CookieCollector,
        @inject(IpGeolocationProvider) private readonly ipGeolocationProvider: IpGeolocationProvider,
        @inject(GlobalLogger) @optional() private readonly logger: GlobalLogger,
        private readonly cookieScenariosProvider: () => CookieScenario[] = getAllCookieScenarios,
    ) {}

    public async run(url: string, page: Page): Promise<PrivacyResults> {
        const privacyScanConfig = await this.serviceConfig.getConfigValue('privacyScanConfig');

        const bannerDetected = await this.detectBanner(url, page, privacyScanConfig);
        this.logger?.logInfo(`Privacy banner ${bannerDetected ? 'was detected.' : 'was not detected.'}`, {
            bannerDetected: `${bannerDetected}`,
            url,
            bannerXPath: privacyScanConfig.bannerXPath,
        });

        const cookieCollectionResults = await this.getAllConsentResults(page);

        return {
            finishDateTime: new Date(),
            navigationalUri: page.url,
            bannerDetectionXpathExpression: privacyScanConfig.bannerXPath,
            bannerDetected,
            cookieCollectionConsentResults: cookieCollectionResults,
            geolocation: this.ipGeolocationProvider.getIpGeolocation(),
        };
    }

    private async detectBanner(url: string, page: Page, privacyScanConfig: PrivacyScanConfig): Promise<boolean> {
        try {
            await page.puppeteerPage.waitForXPath(privacyScanConfig.bannerXPath, {
                timeout: privacyScanConfig.bannerDetectionTimeout,
            });

            return true;
        } catch (error) {
            if (error.name !== 'TimeoutError') {
                this.logger?.logError('Privacy banner detection error.', { url, browserError: System.serializeError(error) });
                throw error;
            }

            return false;
        }
    }

    private async getAllConsentResults(page: Page): Promise<ConsentResult[]> {
        const results: ConsentResult[] = [];
        const scenarios = this.cookieScenariosProvider();

        // Run scenarios sequentially so that cookie values don't interfere with each other
        for (const scenario of scenarios) {
            const result = await this.cookieCollector.getCookiesForScenario(page, scenario);
            results.push(result);
        }

        return results;
    }
}
