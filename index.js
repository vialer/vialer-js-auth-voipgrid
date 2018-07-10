const UserProvider = require('vialer-js/src/js/bg/modules/user/provider')

class UserProviderVoipgrid extends UserProvider {
    constructor() {
        console.log("CUSTOM MODULE!")
    }
}

module.exports = UserProviderVoipgrid
