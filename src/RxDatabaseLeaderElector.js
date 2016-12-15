import * as RxChangeEvent from './RxChangeEvent';
import * as util from './util';
import * as unload from 'unload';

/**
 * this handles the leader-election for the given RxDatabase-instance
 */
class RxDatabaseLeaderElector {
    constructor(database) {

        // things that must be cleared ondestroy
        this.subs = [];
        this.unloads = [];

        this.database = database;
        this.deathLeaders = []; // tokens of death leaders
        this.isLeader = false;
        this.becomeLeader$ = new util.Rx.BehaviorSubject(this.isLeader);
        this.isDead = false;
        this.isApplying = false;
        this.socketMessages$ = database.observable$
            .filter(cEvent => cEvent.data.it != this.database.token)
            .filter(cEvent => cEvent.data.op.startsWith('Leader.'))
            .map(cEvent => {
                return {
                    type: cEvent.data.op.split('.')[1],
                    token: cEvent.data.it,
                    time: cEvent.data.t
                };
            })
            // do not handle messages from death leaders
            .filter(m => !this.deathLeaders.includes(m.token))
            .do(m => {
                if (m.type == 'death')
                    this.deathLeaders.push(m.token);
            });

        this.tellSub = null;
        this.isWaiting = false;
    }

    async prepare() {}

    /**
     * @return {Promise} promise which resolve when the instance becomes leader
     */
    async waitForLeadership() {
        if (this.isLeader) return Promise.resolve(true);
        if (!this.isWaiting) {
            this.isWaiting = true;

            // apply on death
            this.applySub = this.socketMessages$
                .filter(message => message.type == 'death')
                .filter(m => !this.isLeader)
                .subscribe(message => this.applyOnce());
            this.subs.push(this.applySub);

            // apply on interval (backup when leader dies without message)
            this.backupApply = util.Rx.Observable
                .interval(5 * 1000) // TODO evaluate this time
                .subscribe(x => this.applyOnce());
            this.subs.push(this.backupApply);

            // apply now
            this.applyOnce();
        }

        return new Promise(res => {
            this.becomeSub = this.becomeLeader$
                .filter(i => i == true)
                .subscribe(i => res());
            this.subs.push(this.becomeSub);
        });
    }

    /**
     * send a leader-election message over the socket
     * @param {string} type (apply, death, tell)
     * apply: tells the others I want to be leader
     * death: tells the others I will die and they must elect a new leader
     * tell:  tells the others I am leader and they should not elect a new one
     */
    async socketMessage(type) {
        if (!['apply', 'death', 'tell'].includes(type))
            throw new Error('type ' + type + ' is not valid');

        const changeEvent = RxChangeEvent.create(
            'Leader.' + type,
            this.database
        );
        await this.database.writeToSocket(changeEvent);
        return true;
    }

    /**
     * assigns leadership to this instance
     */
    async beLeader() {
        this.isLeader = true;
        this.becomeLeader$.next(true);

        // reply to 'apply'-messages
        this.tellSub = this.socketMessages$
            .filter(message => message.type == 'apply')
            .subscribe(message => this.socketMessage('tell'));
        this.subs.push(this.tellSub);

        // send 'death' when process exits
        this.unloads.push(
            unload.add(() => this.die())
        );

        await this.socketMessage('tell');
    }
    async die() {
        if (!this.isLeader) return;
        this.isDead = true;
        this.isLeader = false;
        this.tellSub.unsubscribe();
        await this.socketMessage('death');
    }

    /**
     * starts applying for leadership
     */
    async applyOnce() {
        if (this.isDead) return;
        if (this.isLeader) return;
        if (this.isApplying) return;

        this.isApplying = true;
        const startTime = new Date().getTime();


        /*        this.socketMessages$.subscribe(m => {
                    console.log('aaaaa:');
                    console.dir(m);
                });*/

        // stop applying when other is leader
        const sub = this.socketMessages$
            .filter(m => m.type == 'tell')
            .filter(m => m.time > startTime)
            .subscribe(message => this.isApplying = false);

        // stop applyling when better is applying (higher lexixal token)
        const sub2 = this.socketMessages$
            .filter(m => m.type == 'apply')
            .filter(m => m.time > startTime)
            .filter(m => this.database.token < m.token)
            .subscribe(m => this.isApplying = false);

        let tries = 0;
        while (tries < 3 && this.isApplying) {
            tries++;
            await this.socketMessage('apply');
            await util.promiseWait(this.database.socketRoundtripTime);
        }
        await this.database.$pull();
        await util.promiseWait(50);

        sub.unsubscribe();
        sub2.unsubscribe();

        if (this.isApplying) await this.beLeader();
        this.isApplying = false;
    }

    async destroy() {
        this.subs.map(sub => sub.unsubscribe());
        this.unloads.map(fn => fn());
        this.die();
    }

}


export async function create(database) {
    const elector = new RxDatabaseLeaderElector(database);
    await elector.prepare();
    return elector;
}
