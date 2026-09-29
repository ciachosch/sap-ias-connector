import { buildScimCreatePayload, attributeToPatch, mapUserType, SCIM_SCHEMAS } from './scim-mapping'

describe('mapUserType', () => {
    it('maps internal to employee and contractor/dealer to external', () => {
        expect(mapUserType('internal')).toBe('employee')
        expect(mapUserType('contractor')).toBe('external')
        expect(mapUserType('dealer')).toBe('external')
    })
    it('maps retiree and resource to valid IAS user types', () => {
        expect(mapUserType('retiree')).toBe('alumni')
        expect(mapUserType('resource')).toBe('technical')
    })
    it('keeps values that are already valid IAS user types', () => {
        expect(mapUserType('public')).toBe('public')
        expect(mapUserType('employee')).toBe('employee')
    })
    it('never forwards an unmapped community IAS would reject — defaults to external', () => {
        // SAP IAS 400s on anything outside its enum, which blocks disable/delete
        expect(mapUserType('non-standard')).toBe('external')
        expect(mapUserType('something-new')).toBe('external')
    })
})

describe('email validation', () => {
    it('omits the VCD "(none)" placeholder and other non-emails from create payload', () => {
        const p = buildScimCreatePayload({ userName: 'jd', email: '(none)', externalEmail: '' })
        expect(p.emails).toBeUndefined()
    })
    it('keeps a valid work email', () => {
        const p = buildScimCreatePayload({ userName: 'jd', email: 'a@b.com' })
        expect(p.emails).toEqual([{ value: 'a@b.com', type: 'work', primary: true }])
    })
})

describe('buildScimCreatePayload', () => {
    it('builds userName from identity fallback and omits active when not provided', () => {
        const p = buildScimCreatePayload({ identity: 'jd' })
        expect(p.userName).toBe('jd')
        expect(p.active).toBeUndefined()
    })

    it('passes active through when explicitly set', () => {
        expect(buildScimCreatePayload({ userName: 'jd', active: false }).active).toBe(false)
        expect(buildScimCreatePayload({ userName: 'jd', active: true }).active).toBe(true)
    })

    it('writes work + external emails as separate typed entries', () => {
        const p = buildScimCreatePayload({ userName: 'jd', email: 'a@x.com', externalEmail: 'b@y.com' })
        expect(p.emails).toEqual([
            { value: 'a@x.com', type: 'work', primary: true },
            { value: 'b@y.com', type: 'other', primary: false },
        ])
    })

    it('places enterprise, custom and carisma attributes into the correct extension objects', () => {
        const p = buildScimCreatePayload({
            userName: 'jd',
            employeeNumber: 'E1',
            manager: 'MGR-9',
            companyCode: 'H040',
            vwgPersonenStatus: '1',
            vwgCommunity: 'Internal',
        })
        expect(p[SCIM_SCHEMAS.enterprise].employeeNumber).toBe('E1')
        expect(p[SCIM_SCHEMAS.custom].attributes).toEqual([{ name: 'customAttribute7', value: 'MGR-9' }])
        expect(p[SCIM_SCHEMAS.carisma].companyCode).toBe('H040')
        expect(p[SCIM_SCHEMAS.carisma].vwgPersonStatus).toBe('1')
        expect(p[SCIM_SCHEMAS.carisma].vwgCommunity).toBe('Internal')
    })

    it('lists only the schemas actually used', () => {
        const p = buildScimCreatePayload({ userName: 'jd', employeeNumber: 'E1' })
        expect(p.schemas).toContain(SCIM_SCHEMAS.core)
        expect(p.schemas).toContain(SCIM_SCHEMAS.enterprise)
        expect(p.schemas).not.toContain(SCIM_SCHEMAS.carisma)
    })

    it('applies the userType mapping on create', () => {
        const p = buildScimCreatePayload({ userName: 'jd', userType: 'contractor' })
        expect(p.userType).toBe('external')
    })

    it('excludes read-only attributes like loginName', () => {
        const p = buildScimCreatePayload({ userName: 'jd', loginName: 'JD-LOGIN' })
        expect(p[SCIM_SCHEMAS.sap]).toBeUndefined()
    })

    it('omits attributes that are null/undefined', () => {
        const p = buildScimCreatePayload({ userName: 'jd', costCenter: undefined })
        expect(p[SCIM_SCHEMAS.enterprise]).toBeUndefined()
        expect(p.name).toBeUndefined()
    })

    it('writes x509 certificate as primary', () => {
        const p = buildScimCreatePayload({ userName: 'jd', x509Certificate: 'CERT' })
        expect(p.x509Certificates).toEqual([{ value: 'CERT', primary: true }])
    })
})

describe('attributeToPatch', () => {
    it('maps nested core attributes', () => {
        expect(attributeToPatch('givenName')).toEqual({ path: 'name.givenName' })
    })

    it('maps work email to a typed multi-valued path', () => {
        expect(attributeToPatch('email')).toEqual({ path: 'emails[type eq "work"].value' })
    })

    it('maps external email to the other-typed path', () => {
        expect(attributeToPatch('externalEmail')).toEqual({ path: 'emails[type eq "other"].value' })
    })

    it('prefixes extension attributes with their schema URN', () => {
        expect(attributeToPatch('employeeNumber')).toEqual({
            path: `${SCIM_SCHEMAS.enterprise}:employeeNumber`,
        })
        const mgr = attributeToPatch('manager')!
        expect(mgr.buildOp).toBeDefined()
        expect(mgr.buildOp!('MGR-1')).toEqual({
            op: 'replace',
            value: { [SCIM_SCHEMAS.custom]: { attributes: [{ name: 'customAttribute7', value: 'MGR-1' }] } },
        })
        expect(attributeToPatch('companyCode')).toEqual({
            path: `${SCIM_SCHEMAS.carisma}:companyCode`,
        })
    })

    it('returns a transform for userType', () => {
        const m = attributeToPatch('userType')!
        expect(m.transform!('internal')).toBe('employee')
    })

    it('returns null for unmapped attributes', () => {
        expect(attributeToPatch('somethingUnknown')).toBeNull()
    })
})
