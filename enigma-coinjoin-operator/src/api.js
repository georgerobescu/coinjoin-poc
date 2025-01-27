const {SecretContractClient} = require("./secretContractClient");
const {MemoryStore} = require("./memoryStore");
const {PUB_KEY_UPDATE, DEAL_CREATED_UPDATE, DEAL_EXECUTED_UPDATE, QUORUM_UPDATE, THRESHOLD_UPDATE, SUBMIT_DEPOSIT_METADATA, SUBMIT_DEPOSIT_METADATA_SUCCESS, FETCH_FILLABLE_DEPOSITS, FETCH_FILLABLE_SUCCESS, FETCH_FILLABLE_ERROR} = require("enigma-coinjoin-client").actions;
const Web3 = require('web3');
const {DealManager} = require("./dealManager");
const {utils} = require('enigma-js/node');
const EventEmitter = require('events');

/**
 * @typedef {Object} OperatorAction
 * @property {string} action - The action identified
 * @property {Object} payload - The serialized action payload
 */

class OperatorApi {
    constructor(provider, enigmaUrl, contractAddr, scAddr, threshold, accountIndex = 0) {
        this.store = new MemoryStore(); // TODO: Use db backend
        this.web3 = new Web3(provider);
        this.sc = new SecretContractClient(this.web3, scAddr, enigmaUrl, accountIndex);
        this.defaultTaskRecordOpts = {taskGasLimit: 4712388, taskGasPx: 100000000000};
        this.dealManager = new DealManager(this.web3, this.sc, contractAddr, this.store, threshold);
        this.ee = new EventEmitter();
        this.threshold = threshold;

        // TODO: Default Ethereum options, add to config
        this.txOpts = {
            gas: 100712388,
            gasPrice: process.env.GAS_PRICE,
        };
    }

    /**
     * Initialize the stateful components
     * @returns {Promise<void>}
     */
    async initAsync() {
        await this.store.initAsync();
        await this.sc.initAsync(this.defaultTaskRecordOpts);

        process.on('SIGINT', async () => {
            console.log('Caught interrupt signal');

            await store.closeAsync();
            process.exit();
        });
    }

    /**
     * Call broadcast fn on Deal creation
     * @param broadcastCallback
     */
    onDealCreated(broadcastCallback) {
        this.ee.on(DEAL_CREATED_UPDATE, (deal) => {
            console.log('EMIT_DEAL_CREATED');
            broadcastCallback({action: DEAL_CREATED_UPDATE, payload: {deal}})
        });
    }

    /**
     * Call broadcast fn on Deal execution
     * @param broadcastCallback
     */
    onDealExecuted(broadcastCallback) {
        console.log('EMIT_DEAL_EXECUTED');
        this.ee.on(DEAL_EXECUTED_UPDATE, (deal) => broadcastCallback({action: DEAL_EXECUTED_UPDATE, payload: {deal}}));
    }

    /**
     * Call broadcast fn on Quorum update
     * @param broadcastCallback
     */
    onQuorumUpdate(broadcastCallback) {
        console.log('EMIT_QUORUM');
        this.ee.on(QUORUM_UPDATE, (quorum) => broadcastCallback({action: QUORUM_UPDATE, payload: {quorum}}));
    }

    /**
     * Return the threshold value
     * @returns {OperatorAction}
     */
    getThreshold() {
        const threshold = this.threshold;
        return {action: THRESHOLD_UPDATE, payload: {threshold}};
    }

    /**
     * Post-processing after each deposit.
     * Creates a deal if the quorum is reached.
     * @returns {Promise<void>}
     */
    async handleDealProcessingAsync() {
        // TODO: Use a scheduler to trigger this instead post-deposit trigger
        console.log('Evaluating deal creation in non-blocking scope');
        const deal = await this.dealManager.createDealIfQuorumReachedAsync(this.txOpts);
        if (deal !== null) {
            console.log('Broadcasting new deal');
            this.ee.emit(DEAL_CREATED_UPDATE, deal);

            console.log('Broadcasting quorum value 0 after new deal');
            const fillableDeposits = await this.dealManager.fetchFillableDepositsAsync();
            console.log('Fillable deposits after deal', fillableDeposits);
            const quorum = fillableDeposits.length;
            if (quorum !== 0) {
                throw new Error('Data corruption, the quorum should be 0 after creating a deal');
            }
            this.ee.emit(QUORUM_UPDATE, quorum);

            console.log('Deal created on Ethereum, executing...', deal._tx);
            const taskRecordOpts = {taskGasLimit: 47123880, taskGasPx: utils.toGrains(1)};
            await this.dealManager.executeDealAsync(deal, taskRecordOpts);
            console.log('Deal executed on Ethereum', deal._tx);
            this.ee.emit(DEAL_EXECUTED_UPDATE, deal);
        }
    }

    /**
     * Fetch the encryption public key and store it in cache
     * @returns {Promise<OperatorAction>}
     */
    async cachePublicKeyAsync() {
        console.log('Sending encryption public key to new connected client');
        const taskRecordOpts = {taskGasLimit: 4712388, taskGasPx: utils.toGrains(1)};
        const pubKey = await this.sc.getPubKeyAsync(taskRecordOpts);
        return {action: PUB_KEY_UPDATE, payload: {pubKey}};
    }

    /**
     * Coordinate the submission of a new deposit
     * @param sender
     * @param amount
     * @param pubKey
     * @param encRecipient
     * @returns {Promise<OperatorAction>}
     */
    async submitDepositMetadataAsync(sender, amount, pubKey, encRecipient) {
        const registeredDeposit = await this.dealManager.registerDepositAsync(sender, amount, pubKey, encRecipient);
        console.log('Registered deposit', registeredDeposit);

        const fillableDeposits = await this.dealManager.fetchFillableDepositsAsync();
        const quorum = fillableDeposits.length;

        console.log('Broadcasting quorum update', quorum);
        this.ee.emit(QUORUM_UPDATE, quorum);

        // TODO: Is this readable enough?
        // Non-blocking, do not wait for the outcome of port-processing
        (async () => await this.handleDealProcessingAsync())();
        return {action: SUBMIT_DEPOSIT_METADATA_SUCCESS, payload: true};
    }

    /**
     * Return a list of fillable deposits
     * @returns {Promise<OperatorAction>}
     */
    async fetchFillableDepositsAsync(minimumAmount) {
        const deposits = await this.dealManager.fetchFillableDepositsAsync(minimumAmount);
        return {action: FETCH_FILLABLE_SUCCESS, payload: {deposits}};
    }

    /**
     * Return the current Quorum value
     * @returns {Promise<OperatorAction>}
     */
    async fetchQuorumAsync(minimumAmount) {
        // Sending current quorum on connection
        const fillableDeposits = await this.dealManager.fetchFillableDepositsAsync(minimumAmount);
        const quorum = fillableDeposits.length;
        return {action: QUORUM_UPDATE, payload: {quorum}};
    }
}

module.exports = {OperatorApi};