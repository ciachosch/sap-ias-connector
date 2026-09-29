import { connector } from './index'
import { Connector } from '@sailpoint/connector-sdk'

const mockConfig: any = {
    baseUrl: 'https://example.accounts.ondemand.com',
    clientId: 'client-id',
    clientSecret: 'client-secret',
}
process.env.CONNECTOR_CONFIG = Buffer.from(JSON.stringify(mockConfig)).toString('base64')

describe('connector unit tests', () => {
    it('connector SDK major version should match Connector.SDK_VERSION', async () => {
        expect((await connector()).sdkVersion).toStrictEqual(Connector.SDK_VERSION)
    })

    it('registers all expected command handlers', async () => {
        const c = await connector()
        const handlerMap: Map<string, unknown> = (c as any)._handlers
        const registered = [...handlerMap.keys()]
        // Spot-check the commands this connector must support
        for (const cmd of [
            'std:test-connection',
            'std:account:list',
            'std:account:read',
            'std:account:create',
            'std:account:update',
            'std:account:delete',
            'std:account:enable',
            'std:account:disable',
            'std:entitlement:list',
        ]) {
            expect(registered).toContain(cmd)
        }
    })
})
