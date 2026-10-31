import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitName, sameName, ownerRole, decideOwner, patterns, ownSiteEmailFor, isFreemail, isRoleAddress, verdict } from '../src/rules.mjs';

test('names are cleaned and split', () => {
  assert.deepEqual(splitName("Mike O'Brien Jr."), { first: 'mike', last: 'obrien' });
  assert.deepEqual(splitName('José García-López'), { first: 'jose', last: 'garcialopez' });
  assert.equal(splitName(''), null);
  assert.ok(sameName('John Smith', 'J. Smith'));
  assert.ok(!sameName('John Smith', 'Jane Smith'));
  assert.ok(!sameName('Smith', 'John Smith'), 'a surname alone is not a match');
});

test('only owner roles count (D6-1)', () => {
  for (const [t, r] of [['Owner', 'owner'], ['Co-Founder & CEO', 'co_founder'], ['Founder', 'founder'], ['President', 'president'],
    ['CEO', 'ceo'], ['Managing Partner', 'managing_partner'], ['Owner/Operator', 'owner']]) assert.equal(ownerRole(t), r, t);
  for (const t of ['Vice President', 'VP Sales', 'Office Manager', 'General Manager', 'Director of Operations', 'Marketing Coordinator', '', 'Technician'])
    assert.equal(ownerRole(t), null, t);
});

test('an owner is confirmed only by two independent kinds of source', () => {
  const one = decideOwner([{ name: 'Joe Ruiz', title: 'Owner', source: 'web_search' }, { name: 'Joe Ruiz', title: 'Owner', source: 'web_search' }]);
  assert.equal(one.confirmed, false, 'two web-search hits are one source');
  const two = decideOwner([{ name: 'Joe Ruiz', title: 'Owner', source: 'web_search' }, { name: 'Joseph Ruiz', title: 'Owner', source: 'website' }]);
  assert.equal(two.confirmed, false, 'Joe and Joseph are not matched automatically: a person reads it');
  const ok = decideOwner([{ name: 'Joe Ruiz', title: 'Owner', source: 'web_search' }, { name: 'Joe Ruiz', title: 'President', source: 'website' }]);
  assert.equal(ok.confirmed, true);
  assert.equal(ok.owner.name, 'Joe Ruiz');
  const rival = decideOwner([{ name: 'Joe Ruiz', title: 'Owner', source: 'website' }, { name: 'Joe Ruiz', title: 'Owner', source: 'apollo' }, { name: 'Ann Lee', title: 'CEO', source: 'leadocean' }]);
  assert.equal(rival.confirmed, true);
  assert.equal(rival.disagreement, true, 'another name put forward goes to a person');
  const staff = decideOwner([{ name: 'Sam Doe', title: 'Office Manager', source: 'website' }, { name: 'Sam Doe', title: 'Office Manager', source: 'apollo' }]);
  assert.equal(staff.owner, null, 'staff are never taken for owners');
});

test('the 8 patterns, in order; none on a freemail domain', () => {
  assert.deepEqual(patterns('Mike Smith', 'acmehvac.com'), ['mike@acmehvac.com', 'mike.smith@acmehvac.com', 'mikesmith@acmehvac.com', 'msmith@acmehvac.com',
    'smith@acmehvac.com', 'm.smith@acmehvac.com', 'mike_smith@acmehvac.com', 'mike.s@acmehvac.com']);
  assert.deepEqual(patterns('Mike Smith', 'gmail.com'), []);
  assert.deepEqual(patterns('Mike', 'acmehvac.com'), [], 'no surname, no patterns');
});

test('an own-site email stands for the owner only in the allowed cases (D9-2)', () => {
  assert.equal(ownSiteEmailFor('Mike Smith', 'acme.com', ['info@acme.com', 'msmith@acme.com']).email, 'msmith@acme.com');
  assert.equal(ownSiteEmailFor('Mike Smith', 'acme.com', ['info@acme.com', 'mikesmithplumbing@gmail.com']).email, 'mikesmithplumbing@gmail.com');
  assert.equal(ownSiteEmailFor('Mike Smith', 'acme.com', ['acmeplumbing1998@aol.com'], { ownerNamedOnSite: true }).email, 'acmeplumbing1998@aol.com', 'the shop\'s only inbox, on a site that names the owner');
  assert.equal(ownSiteEmailFor('Mike Smith', 'acme.com', ['acmeplumbing1998@aol.com']), null, 'the only inbox, but the site never names the owner');
  assert.equal(ownSiteEmailFor('Bob Lee', 'acme.com', ['ashleelee@gmail.com', 'x@acme.com']), null, '"lee" inside another name is not Bob Lee');
  assert.equal(ownSiteEmailFor('Bob Lee', 'acme.com', ['bob.lee@yahoo.com']).email, 'bob.lee@yahoo.com');
  assert.equal(ownSiteEmailFor('Mike Smith', 'acme.com', ['info@acme.com']), null, 'a role address never stands for the owner');
  assert.equal(ownSiteEmailFor('Mike Smith', 'acme.com', ['a@gmail.com', 'b@yahoo.com']), null, 'two unnamed personal addresses: none chosen');
  assert.ok(isFreemail('x@sbcglobal.net') && !isFreemail('x@acme.com'));
  assert.ok(isRoleAddress('Office@acme.com') && !isRoleAddress('mike@acme.com'));
});

test('verifier answers are normalised', () => {
  assert.equal(verdict('valid'), 'valid');
  assert.equal(verdict('Deliverable'), 'valid');
  assert.equal(verdict('catch_all'), 'catch_all');
  assert.equal(verdict('accept_all'), 'catch_all');
  assert.equal(verdict('invalid'), 'invalid');
  assert.equal(verdict('risky'), 'unknown');
  assert.equal(verdict(undefined), 'unknown');
});
