'use strict';

var _ = require('lodash');
var preconditions = require('preconditions').singleton();

var bitcore = require('bitcore');
var util = bitcore.util;
var Transaction = bitcore.Transaction;
var TransactionBuilder = bitcore.TransactionBuilder;
var Script = bitcore.Script;
var Key = bitcore.Key;

var log = require('../log');

var TX_MAX_SIZE_KB = 50;
var VERSION = 1;
var CORE_FIELDS = ['builderObj', 'inputChainPaths', 'version', 'comment', 'paymentProtocolURL', 'paymentAckMemo'];


function TxProposal(opts) {
  preconditions.checkArgument(opts);
  preconditions.checkArgument(opts.inputChainPaths, 'no inputChainPaths');
  preconditions.checkArgument(opts.builder, 'no builder');
  preconditions.checkArgument(opts.inputChainPaths, 'no inputChainPaths');

  this.inputChainPaths = opts.inputChainPaths;
  this.version = opts.version;
  this.builder = opts.builder;
  this.createdTs = opts.createdTs;

  // Copayer Actions ( copayerId: timeStamp )
  this.signedBy = opts.signedBy || {};
  this.seenBy = opts.seenBy || {};
  this.rejectedBy = opts.rejectedBy || {};

  this.sentTs = opts.sentTs || null;
  this.sentTxid = opts.sentTxid || null;
  this.comment = opts.comment || null;
  this.readonly = opts.readonly || null;
  this.merchant = opts.merchant || null;
  this.paymentAckMemo = null;
  this.paymentProtocolURL = opts.paymentProtocolURL || null;

  // New Tx Proposal
  if (_.isEmpty(this.seenBy) && opts.creator) {
    var now = Date.now();
    var me = {};
    me[opts.creator] = now;

    this.seenBy = me;
    this.signedBy = {};
    this.creator = opts.creator;
    this.createdTs = now;
    if (opts.signWith) {
      if (!this.sign(opts.signWith, opts.creator))
        throw new Error('Could not sign generated tx');
    }
  }
}

TxProposal.prototype._checkPayPro = function() {
  if (!this.merchant) return;

  if (this.paymentProtocolURL !== this.merchant.request_url)
    throw new Error('PayPro: Mismatch on Payment URLs');

  if (!this.merchant.outs || this.merchant.outs.length !== 1)
    throw new Error('PayPro: Unsopported number of outputs');

  if (this.merchant.expires < (this.getSent() || Date.now() / 1000.))
    throw new Error('PayPro: Request expired');

  if (!this.merchant.total || !this.merchant.outs[0].amountSatStr || !this.merchant.outs[0].address)
    throw new Error('PayPro: Missing amount');

  var outs = JSON.parse(this.builder.vanilla.outs);
  if (_.size(outs) != 1)
    throw new Error('PayPro: Wrong outs in Tx');

  var ppOut = this.merchant.outs[0];
  var txOut = outs[0];

  if (ppOut.address !== txOut.address)
    throw new Error('PayPro: Wrong out address in Tx');

  if (ppOut.amountSatStr !== txOut.amountSatStr + '')
    throw new Error('PayPro: Wrong amount in Tx');

};


TxProposal.prototype.isFullySigned = function() {
  return this.builder && this.builder.isFullySigned();
};

TxProposal.prototype.sign = function(keys, signerId) {
  var before = this.countSignatures();
  this.builder.sign(keys);

  var signaturesAdded = this.countSignatures() > before;
  if (signaturesAdded) {
    this.signedBy[signerId] = Date.now();
  }
  return signaturesAdded;
};

TxProposal.prototype._check = function() {

  if (this.builder.signhash && this.builder.signhash !== Transaction.SIGHASH_ALL) {
    throw new Error('Invalid tx proposal');
  }

  var tx = this.builder.build();

  var txSize = tx.getSize();
  if (txSize / 1024 > TX_MAX_SIZE_KB)
    throw new Error('BIG: Invalid TX proposal. Too big: ' + txSize + ' bytes');

console.log('[TxProposal.js.118]'); //TODO
  if (!tx.ins.length)
    throw new Error('Invalid tx proposal: no ins');

  _.each(tx.ins, function(value, index) {
    var scriptSig = value.s;
    if (!scriptSig || !scriptSig.length) {
      throw new Error('Invalid tx proposal: no signatures');
    }
    var hashType = tx.getHashType(index);
    if (hashType && hashType !== Transaction.SIGHASH_ALL)
      throw new Error('Invalid tx proposal: bad signatures');
  });
  this._checkPayPro();
};


TxProposal.prototype.trimForStorage = function() {
  // TODO (remove builder / builderObj. utxos, etc)
  //
  return this;
};

TxProposal.prototype.addMerchantData = function(merchantData) {
  preconditions.checkArgument(merchantData.pr);
  preconditions.checkArgument(merchantData.request_url);
  var m = _.clone(merchantData);

  if (!this.paymentProtocolURL)
    this.paymentProtocolURL = m.request_url;

  // remove unneeded data
  m.raw = m.pr.pki_data = m.pr.signature = undefined;
  this.merchant = m;
  this._checkPayPro();
};

TxProposal.prototype.getScriptSigs = function() {
  var tx = this.builder.build();
  var sigs =  _.map(tx.ins, function(value) {
    value.s.toString('hex');
  });
console.log('[TxProposal.js.161:sigs:]',sigs); //TODO

  return sigs;
};

TxProposal.prototype.rejectCount = function() {
  return _.size(this.rejectedBy);
};


TxProposal.prototype.isFinallyRejected = function(maxRejectCount) {
  return this.rejectCount() > maxRejectCount;
};

TxProposal.prototype.isPending = function(maxRejectCount) {
  preconditions.checkArgument(_.isNumber(maxRejectCount));

  if (this.isFinallyRejected(maxRejectCount) || this.sentTxid)
    return false;

  return true;
};


/**
 * getSignersPubKey
 * @desc get Pubkeys of signers, for each input
 *
 * @return {string[][]} array of arrays for pubkeys for each input
 */
TxProposal.prototype.getSignersPubKey = function(forceUpdate) {

  var signersPubKey = [];

  if (!this._signersPubKey || forceUpdate) {

    log.debug('Verifing signatures...');

    var tx = this.builder.build();
    _.each(tx.ins, function(input, index) {

      var scriptSig = new Script(input.s);
      var signatureCount = scriptSig.countSignatures();
      console.log('[TxProposal.js.191:signatureCount:]', signatureCount); //TODO

      var info = TxProposal._infoFromRedeemScript(scriptSig);
      var txSigHash = tx.hashForSignature(info.script, parseInt(index), Transaction.SIGHASH_ALL);
      var inputSignersPubKey = TxProposal._verifySignatures(info.keys, scriptSig, txSigHash);
      console.log('[TxProposal.js.197:inputSignersPubKey:]', inputSignersPubKey); //TODO

      // Does  scriptSig has strings that are not signatures?
      if (inputSignersPubKey.length !== signatureCount)
        throw new Error('Invalid signature');

      signersPubKey[index] = inputSignersPubKey;
    });
    this._signersPubKey = signersPubKey;
  }

  return this._signersPubKey;
};

TxProposal.prototype.getId = function() {
  preconditions.checkState(this.builder);

  if (!this.ntxid) {
    this.ntxid = this.builder.build().getNormalizedHash().toString('hex');
  }
  return this.ntxid;
};

TxProposal.prototype.toObj = function() {
  var o = JSON.parse(JSON.stringify(this));
  delete o['builder'];
  o.builderObj = this.builder.toObj();
  return o;
};


TxProposal._trim = function(o) {
  var ret = {};
  CORE_FIELDS.forEach(function(k) {
    ret[k] = o[k];
  });
  return ret;
};

TxProposal.fromObj = function(o, forceOpts) {
  preconditions.checkArgument(o.builderObj);
  delete o['builder'];
  forceOpts = forceOpts || {};


  if (forceOpts) {
    o.builderObj.opts = o.builderObj.opts || {};
  }

  // force opts is requested.
  for (var k in forceOpts) {
    o.builderObj.opts[k] = forceOpts[k];
  }
  // Handle undef options
  if (_.isUndefined(forceOpts.fee) && _.isUndefined(forceOpts.feeSat)) {
    if (o.builderObj.opts) {
      o.builderObj.opts.fee = undefined;
      o.builderObj.opts.feeSat = undefined;
    }
  }

  try {
    o.builder = TransactionBuilder.fromObj(o.builderObj);
  } catch (e) {
    log.info('Ignoring TXP:', e);
    return null;
  }
  return new TxProposal(o);
};

TxProposal.fromUntrustedObj = function(o, forceOpts) {
  var txp = TxProposal.fromObj(TxProposal._trim(o), forceOpts);
  if (!txp)
    throw new Error('Invalid Transaction');

  txp._check();
  return txp;
};

TxProposal.prototype.toObjTrim = function() {
  return TxProposal._trim(this.toObj());
};

TxProposal._formatKeys = function(keys) {
  var ret = [];
  for (var i in keys) {
    if (!Buffer.isBuffer(keys[i]))
      throw new Error('keys must be buffers');

    var k = new Key();
    k.public = keys[i];
    ret.push({
      keyObj: k,
      keyHex: keys[i].toString('hex'),
    });
  }
  return ret;
};

TxProposal._verifySignatures = function(inKeys, scriptSig, txSigHash) {
  preconditions.checkArgument(Buffer.isBuffer(txSigHash));
  preconditions.checkArgument(inKeys);
  preconditions.checkState(Buffer.isBuffer(inKeys[0]));

  if (scriptSig.chunks[0] !== 0)
    throw new Error('Invalid scriptSig');

  var keys = TxProposal._formatKeys(inKeys);
  var ret = [];
  for (var i = 1; i <= scriptSig.countSignatures(); i++) {
    var chunk = scriptSig.chunks[i];
    var sigRaw = new Buffer(chunk.slice(0, chunk.length - 1));
    for (var j in keys) {
      var k = keys[j];
      if (k.keyObj.verifySignatureSync(txSigHash, sigRaw)) {
        ret.push(k.keyHex);
        break;
      }
    }
  }
  return ret;
};

TxProposal._infoFromRedeemScript = function(s) {
  var redeemScript = new Script(s.chunks[s.chunks.length - 1]);
  if (!redeemScript)
    throw new Error('Bad scriptSig (no redeemscript)');

  var pubkeys = redeemScript.capture();
  if (!pubkeys || !pubkeys.length)
    throw new Error('Bad scriptSig (no pubkeys)');

  return {
    keys: pubkeys,
    script: redeemScript,
  };
};

TxProposal.prototype.getSeen = function(copayerId) {
  return this.seenBy[copayerId];
};

TxProposal.prototype.setSeen = function(copayerId) {
  if (!this.seenBy[copayerId])
    this.seenBy[copayerId] = Date.now();
};

TxProposal.prototype.setRejected = function(copayerId) {

  if (this.signedBy[copayerId])
    throw new Error('Can not reject a signed TX');

  if (!this.rejectedBy[copayerId])
    this.rejectedBy[copayerId] = Date.now();

  return this;
};

TxProposal.prototype.setSent = function(sentTxid) {
  this.sentTxid = sentTxid;
  this.sentTs = Date.now();
  return this;
};

TxProposal.prototype.getSent = function() {
  return this.sentTs;
}

TxProposal.prototype.setCopayers = function(senderId, keyMap) {
  var newCopayer = {},
    oldCopayers = {},
    newSignedBy = {},
    readOnlyPeers = {},
    isNew = 1;

  for (var k in this.signedBy) {
    oldCopayers[k] = 1;
    isNew = 0;
  };

  if (isNew == 0) {
    if (!this.creator || !this.createdTs)
      throw new Error('Existing TX has no creator');

    if (!this.signedBy[this.creator])
      throw new Error('Existing TX is not signed by creator');


    if (Object.keys(this.signedBy).length === 0)
      throw new Error('Existing TX has no signatures');
  }


  var iSig = this.getSignersPubKey();
  console.log('[TxProposal.js.374:iSig:]', iSig, keyMap); //TODO
  for (var i in iSig) {
    var copayerId = keyMap[iSig[i]];

    if (!copayerId)
      throw new Error('Found unknown signature')

    if (oldCopayers[copayerId]) {
      //Already have it. Do nothing
    } else {
      newCopayer[copayerId] = Date.now();
      delete oldCopayers[i];
    }
  }

  if (Object.keys(newCopayer).length > 1)
    throw new Error('New TX must have only 1 new signature');

  // Handler creator / createdTs.
  // from senderId, and must be signed by senderId
  if (isNew) {
    this.creator = Object.keys(newCopayer)[0];
    this.seenBy[this.creator] = this.createdTs = Date.now();
  }

  //Ended. Update this.
  for (var i in newCopayer) {
    this.signedBy[i] = newCopayer[i];
  }

  // signedBy has preference over rejectedBy
  for (var i in this.signedBy) {
    delete this.rejectedBy[i];
  }

  console.log('[TxProposal.js.410:newCopayer:]', newCopayer); //TODO
  return Object.keys(newCopayer);
};

// merge will not merge any metadata.
TxProposal.prototype.merge = function(incoming) {

  // Note that all inputs must have the same number of signatures, so checking
  // one (0) is OK.
  var before = this._inputSigners[0] ? this._inputSigners[0].length : 0;
  this.builder.merge(incoming.builder);

  var after = this._inputSigners[0].length;
  console.log('[TxProposal.js.442:after:]', before, after); //TODO
  return after !== before;
};

//This should be on bitcore / Transaction
TxProposal.prototype.countSignatures = function() {
  var tx = this.builder.build();
  var ret = 0;
  for (var i in tx.ins) {
    ret += tx.countInputSignatures(i);
  }
  return ret;
};

module.exports = TxProposal;
