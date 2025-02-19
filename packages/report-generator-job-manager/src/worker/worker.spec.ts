// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import 'reflect-metadata';

import { Batch, BatchConfig, BatchTask, JobTask, JobTaskState, PoolLoadGenerator, PoolLoadSnapshot, PoolMetricsInfo } from 'azure-services';
import { ServiceConfiguration, GuidGenerator, JobManagerConfig, ScanRunTimeConfig } from 'common';
import _ from 'lodash';
import * as mockDate from 'mockdate';
import { BatchPoolLoadSnapshotProvider, ScanMessage, ReportGeneratorRequestProvider, ScanReportGroup } from 'service-library';
import { OnDemandPageScanResult, StorageDocument } from 'storage-documents';
import { IMock, It, Mock } from 'typemoq';
import { MockableLogger } from '../test-utilities/mockable-logger';
import { Worker, BatchTaskArguments } from './worker';

/* eslint-disable no-invalid-this, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any, no-bitwise */

enum EnableBaseWorkflow {
    none,
    onTasksAdded = 1 << 1,
    handleFailedTasks = 1 << 2,
}

class TestableWorker extends Worker {
    public enableBaseWorkflow: EnableBaseWorkflow;

    public onTasksAddedCallback: (tasks: JobTask[]) => Promise<void>;

    public excludeCompletedScansCallback: (scanMessages: ScanMessage[]) => Promise<ScanMessage[]>;

    public handleFailedTasksCallback: (failedTasks: BatchTask[]) => Promise<void>;

    public activeScanMessages: ScanMessage[];

    public async getMessagesForTaskCreation(): Promise<ScanMessage[]> {
        return super.getMessagesForTaskCreation();
    }

    public async onTasksValidation(): Promise<void> {
        return super.handleFailedTasks([]);
    }

    public async handleFailedTasks(failedTasks: BatchTask[]): Promise<void> {
        await this.invokeOverrides(
            EnableBaseWorkflow.handleFailedTasks,
            this.handleFailedTasksCallback,
            async () => super.handleFailedTasks(failedTasks),
            undefined,
            failedTasks,
        );
    }

    public async onTasksAdded(tasks: JobTask[]): Promise<void> {
        await this.invokeOverrides(
            EnableBaseWorkflow.onTasksAdded,
            this.onTasksAddedCallback,
            async () => super.onTasksAdded(tasks),
            undefined,
            tasks,
        );
    }

    private async invokeOverrides(
        workflow: EnableBaseWorkflow,
        callback: any,
        baseWorkflow?: any,
        defaultResult?: any,
        ...params: any
    ): Promise<any> {
        if (callback !== undefined) {
            return callback(...params);
        }

        if ((this.enableBaseWorkflow & workflow) === workflow) {
            return baseWorkflow(...params);
        }

        return defaultResult;
    }
}

class ReportRequestGenerator {
    public scanMessagesByRun: ScanMessage[][] = [];

    public scanMessages: ScanMessage[] = [];

    public jobTasksByRun: JobTask[][] = [];

    public jobTasks: JobTask[] = [];

    public runCount = 0;

    public maxRunCount = 2;

    public messagesPerRun = 3;

    public queueMessagesGeneratorFn = () => () => {
        let messages: ScanMessage[] = [];
        if (this.runCount < this.maxRunCount) {
            messages = createScanMessages(this.messagesPerRun, this.runCount * this.maxRunCount);
            this.scanMessagesByRun[this.runCount] = messages;
            this.scanMessages.push(...messages);
            this.runCount += 1;
        }

        return messages;
    };

    public jobTaskGeneratorFn = () => () => {
        if (this.runCount === 0) {
            return [];
        }

        const jobTasks = createJobTasks(this.scanMessagesByRun[this.runCount - 1]);
        this.jobTasksByRun[this.runCount - 1] = jobTasks;
        this.jobTasks.push(...jobTasks);

        return jobTasks;
    };
}

const jobGroup = 'jobGroup';
const dateNowIso = '2019-12-12T12:00:00.000Z';
const failedScanRetryIntervalInMinutes = 5;
mockDate.set(dateNowIso);

let testSubject: TestableWorker;
let batchMock: IMock<Batch>;
let poolLoadGeneratorMock: IMock<PoolLoadGenerator>;
let serviceConfigMock: IMock<ServiceConfiguration>;
let loggerMock: IMock<MockableLogger>;
let batchPoolLoadSnapshotProviderMock: IMock<BatchPoolLoadSnapshotProvider>;
let reportGeneratorRequestProviderMock: IMock<ReportGeneratorRequestProvider>;
let guidGeneratorMock: IMock<GuidGenerator>;
let poolMetricsInfo: PoolMetricsInfo;
let batchConfig: BatchConfig;
let reportRequestGenerator: ReportRequestGenerator;

describe(Worker, () => {
    beforeEach(async () => {
        batchConfig = {
            accountName: 'batch-account-name',
            accountUrl: '',
            poolId: 'pool-Id',
            jobId: 'batch-job-id',
        } as BatchConfig;

        poolMetricsInfo = {
            id: 'pool-id',
            maxTasksPerPool: 4,
            load: {
                activeTasks: 0,
                runningTasks: 1,
            },
        };

        batchMock = Mock.ofType(Batch);
        poolLoadGeneratorMock = Mock.ofType(PoolLoadGenerator);
        batchPoolLoadSnapshotProviderMock = Mock.ofType(BatchPoolLoadSnapshotProvider);
        reportGeneratorRequestProviderMock = Mock.ofType(ReportGeneratorRequestProvider);
        loggerMock = Mock.ofType(MockableLogger);
        guidGeneratorMock = Mock.ofType(GuidGenerator);
        serviceConfigMock = Mock.ofType(ServiceConfiguration);

        batchMock.setup((o) => o.getPoolMetricsInfo(jobGroup)).returns(async () => Promise.resolve(poolMetricsInfo));
        guidGeneratorMock.setup((o) => o.createGuid()).returns(() => 'guid');

        serviceConfigMock
            .setup((o) => o.getConfigValue('jobManagerConfig'))
            .returns(() => Promise.resolve({ reportGeneratorJobGroup: jobGroup } as JobManagerConfig))
            .verifiable();
        serviceConfigMock
            .setup((o) => o.getConfigValue('scanConfig'))
            .returns(() => Promise.resolve({ failedScanRetryIntervalInMinutes } as ScanRunTimeConfig))
            .verifiable();

        reportRequestGenerator = new ReportRequestGenerator();

        testSubject = new TestableWorker(
            batchMock.object,
            poolLoadGeneratorMock.object,
            batchPoolLoadSnapshotProviderMock.object,
            reportGeneratorRequestProviderMock.object,
            batchConfig,
            serviceConfigMock.object,
            loggerMock.object,
            guidGeneratorMock.object,
        );
        await testSubject.init();
    });

    afterEach(() => {
        batchMock.verifyAll();
        poolLoadGeneratorMock.verifyAll();
        batchPoolLoadSnapshotProviderMock.verifyAll();
        reportGeneratorRequestProviderMock.verifyAll();
        serviceConfigMock.verifyAll();
        loggerMock.verifyAll();
        guidGeneratorMock.verifyAll();
    });

    afterAll(() => {
        mockDate.reset();
    });

    it('skip getting messages if pool has no available slots', async () => {
        const poolLoadSnapshot = {
            tasksIncrementCountPerInterval: 0,
            samplingIntervalInSeconds: 15,
        } as PoolLoadSnapshot;
        poolLoadGeneratorMock
            .setup((o) => o.getPoolLoadSnapshot(poolMetricsInfo))
            .returns(async () => Promise.resolve(poolLoadSnapshot))
            .verifiable();
        batchPoolLoadSnapshotProviderMock
            .setup((o) =>
                o.writeBatchPoolLoadSnapshot(
                    It.isValue({
                        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                        ...({} as StorageDocument),
                        batchAccountName: batchConfig.accountName,
                        ...poolLoadSnapshot,
                    }),
                ),
            )
            .verifiable();
        loggerMock
            .setup((o) =>
                o.trackEvent(
                    'BatchPoolStats',
                    null,
                    It.isValue({
                        runningTasks: poolMetricsInfo.load.runningTasks,
                        samplingIntervalInSeconds: poolLoadSnapshot.samplingIntervalInSeconds,
                        maxParallelTasks: poolMetricsInfo.maxTasksPerPool,
                    }),
                ),
            )
            .verifiable();

        const actualMessages = await testSubject.getMessagesForTaskCreation();

        expect(actualMessages).toEqual([]);
    });

    it('get report requests', async () => {
        const poolLoadSnapshot = {
            tasksIncrementCountPerInterval: 10,
            samplingIntervalInSeconds: 15,
        } as PoolLoadSnapshot;
        poolLoadGeneratorMock
            .setup((o) => o.getPoolLoadSnapshot(poolMetricsInfo))
            .returns(async () => Promise.resolve(poolLoadSnapshot))
            .verifiable();
        batchPoolLoadSnapshotProviderMock
            .setup((o) =>
                o.writeBatchPoolLoadSnapshot(
                    It.isValue({
                        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                        ...({} as StorageDocument),
                        batchAccountName: batchConfig.accountName,
                        ...poolLoadSnapshot,
                    }),
                ),
            )
            .verifiable();

        reportRequestGenerator.queueMessagesGeneratorFn()();
        const scanReportGroups = reportRequestGenerator.scanMessages.map((m) => {
            return {
                scanGroupId: m.scanId,
                targetReport: 'accessibility',
            } as ScanReportGroup;
        });
        scanReportGroups.push({} as ScanReportGroup); // empty report to be removed
        const cosmosOperationResponse = {
            item: scanReportGroups,
            statusCode: 200,
        };
        reportGeneratorRequestProviderMock
            .setup((o) => o.readScanGroupIds(failedScanRetryIntervalInMinutes, poolLoadSnapshot.tasksIncrementCountPerInterval, undefined))
            .returns(() => Promise.resolve(cosmosOperationResponse))
            .verifiable();

        loggerMock
            .setup((o) =>
                o.trackEvent(
                    'BatchPoolStats',
                    null,
                    It.isValue({
                        runningTasks: poolMetricsInfo.load.runningTasks,
                        samplingIntervalInSeconds: poolLoadSnapshot.samplingIntervalInSeconds,
                        maxParallelTasks: poolMetricsInfo.maxTasksPerPool,
                    }),
                ),
            )
            .verifiable();

        const actualMessages = await testSubject.getMessagesForTaskCreation();

        expect(actualMessages).toEqual(reportRequestGenerator.scanMessages);
    });

    it('update pool stats when tasks added', async () => {
        const tasks = [{}, {}, {}];
        poolLoadGeneratorMock.setup((o) => o.setLastTasksIncrementCount(tasks.length)).verifiable();
        testSubject.enableBaseWorkflow = EnableBaseWorkflow.onTasksAdded;

        await testSubject.onTasksAdded(tasks as JobTask[]);
    });

    it('handleFailedTasks() - skip if task has no scan group id argument', async () => {
        const failedTasks = [
            {
                id: 'id',
                taskArguments: '{}',
            },
        ] as BatchTask[];

        loggerMock
            .setup((o) =>
                o.logError(
                    `Report generator batch task was terminated unexpectedly.`,
                    It.isValue({
                        correlatedBatchTaskId: failedTasks[0].id,
                        taskProperties: JSON.stringify(failedTasks[0]),
                    }),
                ),
            )
            .verifiable();

        testSubject.enableBaseWorkflow = EnableBaseWorkflow.handleFailedTasks;

        await testSubject.handleFailedTasks(failedTasks);
    });

    it('handleFailedTasks() - log task error', async () => {
        const failedTasks: BatchTask[] = [];
        const pageScanResults: OnDemandPageScanResult[] = [];

        for (let i = 0; i < 2; i += 1) {
            const scanId = `scan-id-${i}`;
            failedTasks.push({
                id: `task-id-${i}`,
                correlationId: scanId,
                exitCode: 1,
                timestamp: new Date(),
                failureInfo: {
                    category: 'serverError',
                    message: `failureInfo-message-${i}`,
                },
                taskArguments: JSON.stringify({ id: scanId }),
            } as BatchTask);

            const error = `Task was terminated unexpectedly. Exit code: 1`;
            const error2 = `${error}, Error category: serverError, Error details: ${failedTasks[0].failureInfo.message}`;
            pageScanResults.push({
                run: {
                    state: 'failed',
                    timestamp: new Date().toJSON(),
                    error: error2,
                },
            } as OnDemandPageScanResult);
        }

        testSubject.enableBaseWorkflow = EnableBaseWorkflow.handleFailedTasks;

        await testSubject.handleFailedTasks(failedTasks);
    });
});

function createJobTasks(messages: ScanMessage[]): JobTask[] {
    let count = 0;

    const stateGeneratorFn = (seed: number): JobTaskState => {
        if (seed === 2) {
            return JobTaskState.failed;
        } else if (seed === 3) {
            return JobTaskState.completed;
        }

        return JobTaskState.queued;
    };

    return messages.map((m) => {
        count += 1;

        return {
            id: `task-id-${m.scanId}_${m.messageId}_${Date.now}`,
            correlationId: m.messageId,
            state: stateGeneratorFn(count),
        } as JobTask;
    });
}

function createScanMessages(count: number, shift: number = 0): ScanMessage[] {
    const scanMessages: ScanMessage[] = [];
    for (let i = shift; i < count + shift; i += 1) {
        scanMessages.push({
            scanId: `scan-id-${i}`,
            messageId: `guid`,
            message: {
                messageId: `guid`,
                messageText: JSON.stringify(<BatchTaskArguments>{
                    id: `guid`,
                    scanGroupId: `scan-id-${i}`,
                    targetReport: 'accessibility',
                }),
            },
        });
    }

    return scanMessages;
}
