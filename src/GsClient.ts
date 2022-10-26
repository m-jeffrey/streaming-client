import { log } from './logger.js';
import WebSocket from 'ws';
import { Client, createClient as createWSClient, SubscribePayload } from 'graphql-ws';
import { Call } from './Call.js';

export class GsClient {

    public offset: number;
    private env: any;
    private wsUrl: string;
    private oauthUrl: string;
    private oauthOptions: any;
    private call: Call;
    private activeSocket: WebSocket | null = null;
    // private activeClient: Client | null = null;

    public constructor(env: any, wsUrl: string, oauthUrl: string, oauthOptions: any, call: Call) {
        this.offset = env.OFFSET;
        this.env = env;
        this.wsUrl = wsUrl;
        this.oauthUrl = oauthUrl;
        this.oauthOptions = oauthOptions;
        this.call = call;
    }

    public getClient(): Client {
        log.debug('Creating client');
        let timedOut: any;
        const client: Client =  createWSClient({
            webSocketImpl: WebSocket,
            url: this.wsUrl,
            connectionParams: async() => {
                log.debug(`Starting from offset ${ (this.offset) ? this.offset : 'latest'}`);
                return {
                    'Authorization': `Bearer ${(await this.call.fetchToken(this.oauthUrl, this.oauthOptions)).access_token}`,
                    'x-app-key': `${this.env.APP_KEY}`
                };
            },
            shouldRetry: () => true,
            lazy: true,
            keepAlive: (this.env.PING), // frequency to ping server
            on: {
                connecting: () => {
                    log.info(`Connecting to socket ${this.wsUrl}`);
                },
                connected: (socket: any) => {
                    this.activeSocket = socket;
                    log.debug('Connected to socket');
                    // setTimeout(() => {
                    //     log.info('Refreshing connection with new token');
                    //     activeSocket.close(4408, 'Token Expired');
                    // }, env.TOKEN_EXPIRY );
                },
                closed: (event: any) => {
                    log.error(`Socket closed with event ${event.code} ${event.reason}`);
                },
                ping: (received) => {
                    if (!received) // sent
                        timedOut = setTimeout(() => {
                            if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN)
                                this.activeSocket.close(4408, 'Request Timeout');
                        }, this.env.PING / 2); // if pong not received within this timeframe then recreate connection
                },
                pong: (received) => {
                    if (received) clearTimeout(timedOut); // pong is received, clear connection close timeout
                },
                error: (error) => {
                    log.error(error);
                }
            }
        });
        return client;
    }

    // generate GraphQL Subscription query
    private createQuery(chainCode: string | undefined, offset?: number | undefined, hotelCode?: string | undefined, delta?: boolean): any {
        const query = `subscription {
                newEvent (input:{chainCode: "${chainCode}"
                    ${ (offset!==undefined) ? `, offset: "${offset}"` : '' }
                    ${ (hotelCode!==undefined) ? `, hotelCode: "${hotelCode}"` : '' }
                    ${ (delta!==undefined) ? `, delta: ${delta}` : '' }}){
                    metadata {
                        offset
                        uniqueEventId
                    }
                    moduleName
                    eventName
                    primaryKey
                    timestamp
                    hotelId
                    publisherId
                    actionInstanceId
                    detail {
                        elementName
                        elementType
                        elementSequence
                        elementRole
                        newValue
                        oldValue
                        scopeFrom
                        scopeTo
                    }
                }
            }`;
        return query.replace(/\s+/g, ' ').trim();
    }

    // Function to start the connection
    public async subscribe<T>(client: Client) {
        const query = this.createQuery(this.env.CHAIN,this.offset,this.env.HOTELID,this.env.DELTA);
        const payload: SubscribePayload = {query};
        return new Promise<T>((resolve, reject) => {
            let result: any;
            log.info(query);
            if (client) {
                client.subscribe<T>(payload, {
                    next: (data) => {
                        result = data;
                        this.offset = Number(result.data.newEvent.metadata.offset) + 1;
                        log.info(`Processed ${result.data.newEvent.eventName} event with: offset ${result.data.newEvent.metadata.offset}, primaryKey ${result.data.newEvent.primaryKey}, HotelId ${(result.data.newEvent.hotelId) ? result.data.newEvent.hotelId : null}`);
                    },
                    error: (error) => {
                        log.error(error);
                        reject();
                    },
                    complete: () => resolve(result)
                });
            }
        });
    }

    public start(): void {
        let client: Client = this.getClient();
        this.subscribe(client);
        setInterval(async() => {
            log.debug('Refreshing connection');
            client.dispose();
            this.activeSocket?.terminate();
            client = this.getClient();
            this.subscribe(client);
        }, this.env.TOKEN_EXPIRY );
    }
}