'use strict';
const delay = require('delay');
const chalk = require('chalk');

class CreateCertificatePlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.initialized = false;

    this.commands = {
      'create-cert': {
        usage: 'creates a certificate for an existing domain/hosted zone',
        lifecycleEvents: [
          'create'
        ]
      },
    };

    this.hooks = {
      'create-cert:create': this.createCertificate.bind(this),
      'after:deploy:deploy': this.certificateSummary.bind(this),
      'after:info:info': this.certificateSummary.bind(this),
    };
  }

  initializeVariables() {
    if (!this.initialized) {
      this.enabled = this.evaluateEnabled();
      if (this.enabled) {
        const credentials = this.serverless.providers.aws.getCredentials();
        this.route53 = new this.serverless.providers.aws.sdk.Route53(credentials);
        this.region = this.serverless.service.custom.customCertificate.region || 'us-east-1';
        this.domain = this.serverless.service.custom.customCertificate.certificateName;
        const acmCredentials = Object.assign({}, credentials, { region: this.region });
        this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials);
      }

      this.initialized = true;
    }
  }



  /**
   * Determines whether this plug-in should be enabled.
   *
   * This method reads the customDomain property "enabled" to see if this plug-in should be enabled.
   * If the property's value is undefined, a default value of true is assumed (for backwards
   * compatibility).
   * If the property's value is provided, this should be boolean, otherwise an exception is thrown.
   */
  evaluateEnabled() {
    const enabled = this.serverless.service.custom.customDomain.enabled;
    if (enabled === undefined) {
      return true;
    }
    if (typeof enabled === 'boolean') {
      return enabled;
    } else if (typeof enabled === 'string' && enabled === 'true') {
      return true;
    } else if (typeof enabled === 'string' && enabled === 'false') {
      return false;
    }
    throw new Error(`serverless-certificate-creator: Ambiguous enablement boolean: '${enabled}'`);
  }

  reportDisabled() {
    return Promise.resolve()
      .then(() => this.serverless.cli.log('serverless-certificate-creator: Custom domain is disabled.'));
  }

  listCertificates() {
    return this.acm.listCertificates({}).promise();
  }

  getExistingCertificate() {
    return this.listCertificates().then(data => {

      let existingCerts = data.CertificateSummaryList.filter(cert => cert.DomainName === this.domain);
      if (existingCerts.length > 0) {
        return existingCerts[0];
      }
      return undefined;
    });
  }



  /**
   * Creates a certificate for the given options set in serverless.yml under custom->customCertificate
   */
  createCertificate() {

    this.initializeVariables();
    if (!this.enabled) {
      return this.reportDisabled();
    }
    this.serverless.cli.log(`Trying to create certificate for ${this.domain} in ${this.region} ...`);
    return this.getExistingCertificate().then(existingCert => {

      if (existingCert) {
        this.serverless.cli.log(`Certificate for ${this.domain} in ${this.region} already exists. Skipping ...`);
        return;
      }

      let params = {
        DomainName: this.domain,
        ValidationMethod: 'DNS'
      };


      let idempotencyToken = this.serverless.service.custom.customCertificate.idempotencyToken;
      if (idempotencyToken) {
        Object.assign({}, params, { IdempotencyToken: idempotencyToken })
      }

      return this.acm.requestCertificate(params).promise().then(requestCertificateResponse => {
        this.serverless.cli.log('requested cert:' + JSON.stringify(requestCertificateResponse));

        var params = {
          CertificateArn: requestCertificateResponse.CertificateArn
        };

        return delay(10000).then(() => this.acm.describeCertificate(params).promise().then(certificate => {
          this.serverless.cli.log('got cert info: ' + JSON.stringify(certificate));
          var params = {
            ChangeBatch: {
              Changes: [
                {
                  Action: "CREATE",
                  ResourceRecordSet: {
                    Name: certificate.Certificate.DomainValidationOptions[0].ResourceRecord.Name,
                    ResourceRecords: [
                      {
                        Value: certificate.Certificate.DomainValidationOptions[0].ResourceRecord.Value
                      }
                    ],
                    TTL: 60,
                    Type: certificate.Certificate.DomainValidationOptions[0].ResourceRecord.Type
                  }
                }
              ],
              Comment: `DNS Validation for certificate ${certificate.Certificate.DomainValidationOptions[0].DomainName}`
            },
            HostedZoneId: this.serverless.service.custom.customCertificate.hostedZoneId
          };
          this.route53.changeResourceRecordSets(params).promise().then(recordSetResult => {
            this.serverless.cli.log('dns validation record created - soon the certificate is functional');
            console.log(JSON.stringify(recordSetResult));
          }).catch(error => {
            this.serverless.cli.log('could not create record set for dns validation', error);
            console.log('problem', error);
            throw error;
          });

        }).catch(error => {
          this.serverless.cli.log('could not get cert info', error);
          console.log('problem', error);
          throw error;
        }));


      }).catch(error => {
        this.serverless.cli.log('could not request cert', error);
        console.log('problem', error);
        throw error;
      });


    }).catch(error => {
      this.serverless.cli.log('could not get certs', error);
      console.log('problem', error);
      throw error;
    })
  }

  /**
   * Prints out a summary of all domain manager related info
   */
  certificateSummary() {
    this.initializeVariables();
    if (!this.enabled) {
      return this.reportDisabled();
    }
    return this.getExistingCertificate().then(existingCertificate => {
      this.serverless.cli.consoleLog(chalk.yellow.underline('Serverless Certificate Creator Summary'));

      this.serverless.cli.consoleLog(chalk.yellow('Certificate'));
      this.serverless.cli.consoleLog(`  ${existingCertificate.CertificateArn} => ${existingCertificate.DomainName}`);
      return true;
    });
  }
}



module.exports = CreateCertificatePlugin;
