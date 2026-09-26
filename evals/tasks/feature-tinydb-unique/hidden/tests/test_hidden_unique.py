import pytest

from tinydb import TinyDB, Query, where
from tinydb.storages import MemoryStorage
import tinydb


def make_db():
    return TinyDB(storage=MemoryStorage)


def test_errors_are_exported():
    from tinydb.errors import TinyDBError, UniqueConstraintError
    assert tinydb.UniqueConstraintError is UniqueConstraintError
    assert tinydb.TinyDBError is TinyDBError
    assert issubclass(UniqueConstraintError, TinyDBError)
    assert issubclass(TinyDBError, Exception)


def test_insert_duplicate_raises_with_details():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert({'email': 'a@x.com'})
    with pytest.raises(tinydb.UniqueConstraintError) as info:
        users.insert({'email': 'a@x.com', 'name': 'other'})
    assert info.value.field == 'email'
    assert info.value.value == 'a@x.com'
    assert info.value.table == 'users'
    assert len(users) == 1


def test_documents_without_field_are_not_constrained():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert({'name': 'a'})
    users.insert({'name': 'b'})
    users.insert({'email': 'a@x.com'})
    assert len(users) == 3


def test_create_index_rejects_existing_duplicates():
    users = make_db().table('users')
    users.insert({'email': 'a@x.com'})
    users.insert({'email': 'a@x.com'})
    with pytest.raises(tinydb.UniqueConstraintError):
        users.create_unique_index('email')
    assert users.unique_fields == []
    users.insert({'email': 'a@x.com'})
    assert len(users) == 3


def test_unique_fields_order_and_idempotence():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.create_unique_index('login')
    users.create_unique_index('email')
    assert users.unique_fields == ['email', 'login']
    users.drop_unique_index('email')
    users.drop_unique_index('missing')
    assert users.unique_fields == ['login']
    users.insert({'email': 'a'})
    users.insert({'email': 'a'})
    assert len(users) == 2


def test_insert_multiple_is_atomic():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert({'email': 'a'})
    with pytest.raises(tinydb.UniqueConstraintError):
        users.insert_multiple([{'email': 'b'}, {'email': 'c'}, {'email': 'b'}])
    assert [doc['email'] for doc in users.all()] == ['a']
    with pytest.raises(tinydb.UniqueConstraintError):
        users.insert_multiple([{'email': 'd'}, {'email': 'a'}])
    assert len(users) == 1


def test_update_with_fields_is_atomic():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert_multiple([{'email': 'a', 'n': 1}, {'email': 'b', 'n': 2}])
    with pytest.raises(tinydb.UniqueConstraintError):
        users.update({'email': 'a'}, where('n') == 2)
    assert users.get(where('n') == 2)['email'] == 'b'
    with pytest.raises(tinydb.UniqueConstraintError):
        users.update({'email': 'z'})
    assert sorted(doc['email'] for doc in users.all()) == ['a', 'b']
    users.update({'email': 'c'}, doc_ids=[2])
    assert users.get(doc_id=2)['email'] == 'c'


def test_update_with_callable_is_atomic():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert_multiple([{'email': 'a'}, {'email': 'b'}])

    def lower_all(doc):
        doc['email'] = 'same'

    with pytest.raises(tinydb.UniqueConstraintError):
        users.update(lower_all)
    assert sorted(doc['email'] for doc in users.all()) == ['a', 'b']


def test_update_multiple_and_upsert():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert_multiple([{'email': 'a', 'n': 1}, {'email': 'b', 'n': 2}])
    with pytest.raises(tinydb.UniqueConstraintError):
        users.update_multiple([({'email': 'x'}, where('n') == 1), ({'email': 'x'}, where('n') == 2)])
    assert sorted(doc['email'] for doc in users.all()) == ['a', 'b']
    with pytest.raises(tinydb.UniqueConstraintError):
        users.upsert({'email': 'a', 'n': 3}, where('n') == 3)
    assert len(users) == 2
    users.upsert({'email': 'a', 'n': 10}, where('email') == 'a')
    assert users.get(where('email') == 'a')['n'] == 10


def test_updating_same_document_keeps_value():
    users = make_db().table('users')
    users.create_unique_index('email')
    users.insert({'email': 'a', 'n': 1})
    users.update({'email': 'a', 'n': 2}, where('email') == 'a')
    assert users.get(where('email') == 'a')['n'] == 2


def test_default_table_forwarding():
    db = make_db()
    db.create_unique_index('key')
    db.insert({'key': 1})
    with pytest.raises(tinydb.UniqueConstraintError):
        db.insert({'key': 1})
    assert db.unique_fields == ['key']


def test_indexes_are_per_table():
    db = make_db()
    db.table('a').create_unique_index('k')
    db.table('b').insert({'k': 1})
    db.table('b').insert({'k': 1})
    assert db.table('b').unique_fields == []


def test_indexes_persist_and_are_not_tables(tmp_path):
    path = str(tmp_path / 'db.json')
    db = TinyDB(path)
    users = db.table('users')
    users.create_unique_index('email')
    users.insert({'email': 'a'})
    db.insert({'x': 1})
    db.close()

    db = TinyDB(path)
    assert db.tables() == {'_default', 'users'}
    assert db.table('users').unique_fields == ['email']
    with pytest.raises(tinydb.UniqueConstraintError):
        db.table('users').insert({'email': 'a'})
    db.close()


def test_drop_table_drops_its_indexes():
    db = make_db()
    users = db.table('users')
    users.create_unique_index('email')
    users.insert({'email': 'a'})
    db.drop_table('users')
    users = db.table('users')
    assert users.unique_fields == []
    users.insert({'email': 'a'})
    users.insert({'email': 'a'})
    assert len(users) == 2


def test_drop_tables_drops_all_indexes():
    db = make_db()
    db.table('users').create_unique_index('email')
    db.create_unique_index('key')
    db.drop_tables()
    assert db.table('users').unique_fields == []
    assert db.unique_fields == []
    assert db.tables() == set()


def test_unhashable_values_are_compared():
    users = make_db().table('users')
    users.create_unique_index('tags')
    users.insert({'tags': ['a', 'b']})
    with pytest.raises(tinydb.UniqueConstraintError):
        users.insert({'tags': ['a', 'b']})
    users.insert({'tags': ['b', 'a']})
    assert len(users) == 2
